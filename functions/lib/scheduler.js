/**
 * Multi-node direct-routing scheduler (spec 54 Phase 5). Picks a concrete
 * EXIT node for a device, given a target exit location -- the gap
 * FLEET_PLATFORM_PLAN.md identifies explicitly: connection_profiles and
 * allowed_paths resolve only to *locations*; nothing before this picked a
 * specific *node* within one.
 *
 * Live since the fleet-integration work: functions/lib/device-provisioning.js
 * calls these for every device when FEATURE_MULTI_NODE_SCHEDULING is "true"
 * (otherwise devices stay on the legacy single node). They only decide and
 * persist placement; the caller turns placement into VPN identities.
 */

import { CANARY_SESSION_CAP } from "./fleet-operations.js";

/**
 * Pure placement logic: no I/O, no Supabase client. `candidates` is
 * already filtered to nodes that are READY, role EXIT, in the requested
 * location, and not retired -- this function only decides *which one*.
 *
 * Sticky: if `stickyNodeId` names a node still present in `candidates`,
 * it wins outright, regardless of load -- a device should not be bounced
 * to a different node just because another node now has fewer sessions.
 * Otherwise, picks the candidate with the fewest configured_users
 * (least-loaded), breaking ties on node_id for a deterministic, testable
 * result.
 */
export function selectNodeForDevice({ candidates, stickyNodeId }) {
  if (!candidates || candidates.length === 0) return null;

  if (stickyNodeId) {
    const sticky = candidates.find((node) => node.nodeId === stickyNodeId);
    if (sticky) return sticky.nodeId;
  }

  // A null configured_users (no heartbeat reported yet) must sort as the
  // *worst* choice, not the best: treating "unknown" as zero would make an
  // uninstrumented or stale node always win over nodes with genuinely low,
  // actually-reported load.
  const sorted = [...candidates].sort((a, b) => {
    const loadA = a.configuredUsers ?? Infinity;
    const loadB = b.configuredUsers ?? Infinity;
    if (loadA !== loadB) return loadA - loadB;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
  return sorted[0].nodeId;
}

function isUnderCapacity(node) {
  const effectiveMax =
    node.lifecycleState === "CANARY"
      ? Math.min(node.maxSessions ?? Infinity, CANARY_SESSION_CAP)
      : node.maxSessions;
  if (effectiveMax == null) return true;
  return (node.configuredUsers ?? 0) < effectiveMax;
}

/**
 * DB-facing wrapper: loads candidate nodes, the sticky assignment (if
 * any), and the allowed_paths row for the requested direct route, then
 * calls selectNodeForDevice() and persists the result.
 *
 * Fails closed exactly like allowed_paths' own migration comment requires
 * ("no matching row" means "not permitted", never an implicit allow) --
 * returns null rather than picking a node when no enabled direct
 * allowed_paths row exists for exitLocationId, or when no candidate node
 * is available.
 *
 * Gated by env.FEATURE_MULTI_NODE_SCHEDULING === "true" (this codebase has
 * no existing feature-flag convention to reuse -- see plan doc research).
 * Callers must check the flag themselves before invoking this; it is not
 * checked here so unit tests can exercise the scheduling logic without
 * needing to fake env.
 */
export async function scheduleNodeForDevice(supabaseAdmin, { deviceId, exitLocationId }) {
  const [{ data: allowedPath, error: pathError }, { data: sticky, error: stickyError }] = await Promise.all([
    supabaseAdmin
      .from("allowed_paths")
      .select("id")
      .eq("exit_location_id", exitLocationId)
      .is("entry_location_id", null)
      .eq("enabled", true)
      .maybeSingle(),
    supabaseAdmin
      .from("device_node_assignments")
      .select("node_id")
      .eq("device_id", deviceId)
      .eq("hop", "EXIT")
      .maybeSingle(),
  ]);
  if (pathError) throw new Error(`allowed_paths lookup failed: ${pathError.message}`);
  if (stickyError) throw new Error(`device_node_assignments lookup failed: ${stickyError.message}`);
  if (!allowedPath) return null;

  const { data: nodes, error: nodesError } = await supabaseAdmin
    .from("nodes")
    .select("node_id, configured_users, max_sessions, lifecycle_state")
    .eq("role", "EXIT")
    .in("lifecycle_state", ["READY", "CANARY"])
    .eq("location_id", exitLocationId);
  if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);

  const candidates = (nodes ?? [])
    .map((node) => ({
      nodeId: node.node_id,
      configuredUsers: node.configured_users,
      maxSessions: node.max_sessions,
      lifecycleState: node.lifecycle_state,
    }))
    .filter(isUnderCapacity);

  const nodeId = selectNodeForDevice({ candidates, stickyNodeId: sticky?.node_id ?? null });
  if (!nodeId) return null;

  if (nodeId !== sticky?.node_id) {
    const { error: upsertError } = await supabaseAdmin
      .from("device_node_assignments")
      .upsert({ device_id: deviceId, node_id: nodeId, hop: "EXIT" }, { onConflict: "device_id,hop" });
    if (upsertError) throw new Error(`device_node_assignments upsert failed: ${upsertError.message}`);
  }

  return nodeId;
}

/**
 * Double-hop counterpart of scheduleNodeForDevice() (spec 54 Phase 7 /
 * FLEET_PLATFORM_PLAN.md Phase 7). Picks a concrete RELAY node in the
 * entry location and a concrete EXIT node in the exit location for a
 * device whose connection_profiles row has routing_mode = 'DOUBLE_HOP'.
 *
 * Reuses selectNodeForDevice()'s pure placement logic independently for
 * each hop -- same sticky/least-loaded/capacity behavior a direct
 * assignment gets, just run twice against two different candidate pools.
 * Fails closed exactly like scheduleNodeForDevice(): no enabled double-hop
 * allowed_paths row for (entryLocationId, exitLocationId), or no candidate
 * for either hop, returns null and writes nothing -- never a partial
 * assignment with only one hop persisted.
 *
 * Same FEATURE_MULTI_NODE_SCHEDULING-gating contract as
 * scheduleNodeForDevice(): additive, self-contained, not called from any
 * live route yet. Callers must check the flag themselves.
 */
export async function scheduleDoubleHopForDevice(
  supabaseAdmin,
  { deviceId, entryLocationId, exitLocationId }
) {
  const [
    { data: allowedPath, error: pathError },
    { data: relaySticky, error: relayStickyError },
    { data: exitSticky, error: exitStickyError },
  ] = await Promise.all([
    supabaseAdmin
      .from("allowed_paths")
      .select("id")
      .eq("entry_location_id", entryLocationId)
      .eq("exit_location_id", exitLocationId)
      .eq("enabled", true)
      .maybeSingle(),
    supabaseAdmin
      .from("device_node_assignments")
      .select("node_id")
      .eq("device_id", deviceId)
      .eq("hop", "RELAY")
      .maybeSingle(),
    supabaseAdmin
      .from("device_node_assignments")
      .select("node_id")
      .eq("device_id", deviceId)
      .eq("hop", "EXIT")
      .maybeSingle(),
  ]);
  if (pathError) throw new Error(`allowed_paths lookup failed: ${pathError.message}`);
  if (relayStickyError) throw new Error(`device_node_assignments lookup failed: ${relayStickyError.message}`);
  if (exitStickyError) throw new Error(`device_node_assignments lookup failed: ${exitStickyError.message}`);
  if (!allowedPath) return null;

  const [{ data: relayNodes, error: relayNodesError }, { data: exitNodes, error: exitNodesError }] =
    await Promise.all([
      supabaseAdmin
        .from("nodes")
        .select("node_id, configured_users, max_sessions, lifecycle_state")
        .eq("role", "RELAY")
        .in("lifecycle_state", ["READY", "CANARY"])
        .eq("location_id", entryLocationId),
      supabaseAdmin
        .from("nodes")
        .select("node_id, configured_users, max_sessions, lifecycle_state")
        .eq("role", "EXIT")
        .in("lifecycle_state", ["READY", "CANARY"])
        .eq("location_id", exitLocationId),
    ]);
  if (relayNodesError) throw new Error(`nodes lookup failed: ${relayNodesError.message}`);
  if (exitNodesError) throw new Error(`nodes lookup failed: ${exitNodesError.message}`);

  const toCandidates = (nodes) =>
    (nodes ?? [])
      .map((node) => ({
        nodeId: node.node_id,
        configuredUsers: node.configured_users,
        maxSessions: node.max_sessions,
        lifecycleState: node.lifecycle_state,
      }))
      .filter(isUnderCapacity);

  const relayNodeId = selectNodeForDevice({
    candidates: toCandidates(relayNodes),
    stickyNodeId: relaySticky?.node_id ?? null,
  });
  const exitNodeId = selectNodeForDevice({
    candidates: toCandidates(exitNodes),
    stickyNodeId: exitSticky?.node_id ?? null,
  });
  // Fail closed on a partial placement too: a double-hop device must never
  // end up with only one hop scheduled.
  if (!relayNodeId || !exitNodeId) return null;

  const writes = [];
  if (relayNodeId !== relaySticky?.node_id) {
    writes.push({ device_id: deviceId, node_id: relayNodeId, hop: "RELAY" });
  }
  if (exitNodeId !== exitSticky?.node_id) {
    writes.push({ device_id: deviceId, node_id: exitNodeId, hop: "EXIT" });
  }
  if (writes.length > 0) {
    const { error: upsertError } = await supabaseAdmin
      .from("device_node_assignments")
      .upsert(writes, { onConflict: "device_id,hop" });
    if (upsertError) throw new Error(`device_node_assignments upsert failed: ${upsertError.message}`);
  }

  return { relayNodeId, exitNodeId };
}

/**
 * AUTO routing: the device has no fixed exit location. Candidates are READY
 * EXIT nodes in every location that has an ENABLED direct allowed_paths row
 * -- AUTO never widens authorization, it only chooses among routes that are
 * already allowed. Preference order: the device's sticky EXIT assignment,
 * then the node its existing VPN identity already lives on (so enabling
 * fleet scheduling does not needlessly move legacy devices), then least
 * loaded. Returns null (fail closed) when nothing qualifies.
 */
export async function scheduleAutoForDevice(supabaseAdmin, { deviceId, preferredNodeId = null }) {
  const [{ data: paths, error: pathsError }, { data: sticky, error: stickyError }] = await Promise.all([
    supabaseAdmin
      .from("allowed_paths")
      .select("exit_location_id")
      .is("entry_location_id", null)
      .eq("enabled", true),
    supabaseAdmin
      .from("device_node_assignments")
      .select("node_id")
      .eq("device_id", deviceId)
      .eq("hop", "EXIT")
      .maybeSingle(),
  ]);
  if (pathsError) throw new Error(`allowed_paths lookup failed: ${pathsError.message}`);
  if (stickyError) throw new Error(`device_node_assignments lookup failed: ${stickyError.message}`);
  const locationIds = [...new Set((paths ?? []).map((p) => p.exit_location_id))];
  if (locationIds.length === 0) return null;

  const { data: nodes, error: nodesError } = await supabaseAdmin
    .from("nodes")
    .select("node_id, configured_users, max_sessions, lifecycle_state")
    .eq("role", "EXIT")
    .in("lifecycle_state", ["READY", "CANARY"])
    .in("location_id", locationIds);
  if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);

  const candidates = (nodes ?? [])
    .map((node) => ({
      nodeId: node.node_id,
      configuredUsers: node.configured_users,
      maxSessions: node.max_sessions,
      lifecycleState: node.lifecycle_state,
    }))
    .filter(isUnderCapacity);

  const stickyNodeId =
    [sticky?.node_id, preferredNodeId].find((id) => id && candidates.some((c) => c.nodeId === id)) ?? null;
  const nodeId = selectNodeForDevice({ candidates, stickyNodeId });
  if (!nodeId) return null;

  if (nodeId !== sticky?.node_id) {
    const { error: upsertError } = await supabaseAdmin
      .from("device_node_assignments")
      .upsert({ device_id: deviceId, node_id: nodeId, hop: "EXIT" }, { onConflict: "device_id,hop" });
    if (upsertError) throw new Error(`device_node_assignments upsert failed: ${upsertError.message}`);
  }
  return nodeId;
}
