import { getProviderAdapter } from "./provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "./dns-adapter.js";
import { startCreateNodeOperation } from "./fleet-operations.js";
import { isUnderCapacity } from "./scheduler.js";

const SCALE_SUFFIX_PATTERN = /^(.*)-cap(\d+)$/;

/**
 * Names an auto-scaled node de-fsn-001 -> de-fsn-001-cap1 -> de-fsn-001-cap2
 * etc. -- same lineage-in-the-id convention as node-auto-replace.js's -rN
 * suffix, kept as its own "-capN" scheme so a scale-out node is
 * distinguishable at a glance from a replacement.
 *
 * `existingIds` (defaulting to just the template's own id) must include
 * every node id already on record sharing the template's base, regardless
 * of lifecycle state: a scale-out attempt that reached FAILED still
 * permanently occupies its node id (the primary key), so proposing that
 * same id again would only collide (23505) forever rather than actually
 * retrying under a fresh id. The lowest -capN number not already present
 * in `existingIds` is picked, so a gap left by an earlier failure is
 * reused before incrementing past it.
 */
export function nextScaleNodeId(templateNodeId, existingIds = [templateNodeId]) {
  const base = templateNodeId.match(SCALE_SUFFIX_PATTERN)?.[1] ?? templateNodeId;
  const suffixPattern = new RegExp(`^${base}-cap(\\d+)$`);
  const taken = new Set();
  for (const id of existingIds) {
    const match = id.match(suffixPattern);
    if (match) taken.add(Number(match[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${base}-cap${n}`;
}

const CAPACITY_PROVIDING_STATES = new Set(["READY", "CANARY"]);
const IN_FLIGHT_STATES = new Set(["PROVISIONING", "WARMING_UP"]);

/**
 * Pure decision logic: no I/O, no Supabase client. Groups every node by
 * (locationId, role) and flags each group that is capacity-exhausted --
 * it has at least one currently-serving node (READY or CANARY) and none of
 * them has headroom, per the same isUnderCapacity() rule the scheduler
 * itself enforces per-request (including a CANARY node's low effective
 * cap, not its raw max_sessions).
 *
 * A group with a scale-out already in flight (a node there is PROVISIONING
 * or WARMING_UP) is never flagged again -- that node will relieve the
 * group's capacity once it reaches READY, and flagging again here would
 * pile up redundant CREATE_NODE operations every tick until it does.
 *
 * A group with zero serving nodes (e.g. every node there is FAILED or
 * QUARANTINED) is not "exhausted" in the capacity sense this function
 * addresses -- that is a health problem for Phase 8's failover/auto-replace
 * to handle, not something a brand-new node fixes.
 *
 * Each flagged group names a templateNode -- the lowest node_id among its
 * serving nodes, chosen deterministically -- whose `provider` the new node
 * should copy, mirroring the assumption that every node in a given
 * (location, role) is on the same provider.
 */
export function findCapacityExhaustedGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!node.locationId || !node.role) continue;
    const key = `${node.locationId}::${node.role}`;
    if (!groups.has(key)) {
      groups.set(key, { locationId: node.locationId, role: node.role, serving: [], inFlight: false });
    }
    const group = groups.get(key);
    if (CAPACITY_PROVIDING_STATES.has(node.lifecycleState)) group.serving.push(node);
    if (IN_FLIGHT_STATES.has(node.lifecycleState)) group.inFlight = true;
  }

  const exhausted = [];
  for (const group of groups.values()) {
    if (group.serving.length === 0) continue;
    if (group.inFlight) continue;
    if (group.serving.some((node) => isUnderCapacity(node))) continue;
    const templateNode = [...group.serving].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))[0];
    exhausted.push({ locationId: group.locationId, role: group.role, templateNode });
  }
  return exhausted;
}

/**
 * Phase 12c auto-trigger (functions/api/internal/fleet-tick.js), gated by
 * the caller checking FEATURE_AUTO_NODE_SCALE. Finds every (location, role)
 * group with no headroom left across its serving nodes and starts a plain
 * CREATE_NODE operation for a brand-new node there -- not a replacement,
 * no old node involved. One new node per exhausted group per tick;
 * findCapacityExhaustedGroups' in-flight check prevents piling up more
 * until that one reaches READY or fails.
 *
 * Requires FLEET_AUTO_SCALE_REGION: like node-auto-replace.js's
 * FLEET_AUTO_REPLACE_REGION, there is no human supplying a provisioning
 * region per call here. No-ops (logs and returns []) rather than throwing
 * when unconfigured, for the same fleet-tick-must-not-interrupt-unrelated-
 * work reason.
 */
export async function autoScaleFullLocations(supabase, env) {
  if (env.FEATURE_AUTO_NODE_SCALE !== "true") return [];
  const region = env.FLEET_AUTO_SCALE_REGION;
  if (!region) {
    console.error("node-auto-scale: FLEET_AUTO_SCALE_REGION is not configured");
    return [];
  }

  const { data: nodes, error } = await supabase
    .from("nodes")
    .select("node_id, role, location_id, provider, configured_users, max_sessions, lifecycle_state")
    .in("lifecycle_state", ["READY", "CANARY", "PROVISIONING", "WARMING_UP"]);
  if (error) {
    console.error("node-auto-scale: candidate query failed:", error.message);
    return [];
  }

  const mapped = (nodes ?? []).map((node) => ({
    nodeId: node.node_id,
    role: node.role,
    locationId: node.location_id,
    provider: node.provider,
    configuredUsers: node.configured_users,
    maxSessions: node.max_sessions,
    lifecycleState: node.lifecycle_state,
  }));

  const started = [];
  for (const group of findCapacityExhaustedGroups(mapped)) {
    const { templateNode } = group;
    if (!templateNode.provider) {
      console.error(
        `node-auto-scale: template node ${templateNode.nodeId} has no provider on record, skipping ${group.locationId}/${group.role}`
      );
      continue;
    }

    const base = templateNode.nodeId.match(SCALE_SUFFIX_PATTERN)?.[1] ?? templateNode.nodeId;
    const { data: sameBaseNodes, error: sameBaseError } = await supabase
      .from("nodes")
      .select("node_id")
      .like("node_id", `${base}-cap%`);
    if (sameBaseError) {
      console.error(
        `node-auto-scale: node id lookup failed for ${group.locationId}/${group.role}:`,
        sameBaseError.message
      );
      continue;
    }
    const newNodeId = nextScaleNodeId(templateNode.nodeId, (sameBaseNodes ?? []).map((n) => n.node_id));
    let hostname;
    try {
      getProviderAdapter(templateNode.provider, env);
      if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
      getDnsAdapter(env);
      hostname = nodeHostname(newNodeId, env);
    } catch (err) {
      console.error(`node-auto-scale: provisioning not configured for ${templateNode.provider}:`, err.message);
      continue;
    }

    const { operation, error: startError } = await startCreateNodeOperation(supabase, {
      nodeId: newNodeId,
      role: group.role,
      locationId: group.locationId,
      provider: templateNode.provider,
      region,
      hostname,
    });
    if (startError) {
      if (startError.code !== "23505") {
        console.error(
          `node-auto-scale: failed to start scale-out for ${group.locationId}/${group.role}:`,
          startError.message
        );
      }
      continue;
    }
    started.push({ locationId: group.locationId, role: group.role, newNodeId, operationId: operation.id });
  }
  return started;
}
