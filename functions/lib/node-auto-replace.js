import { getProviderAdapter } from "./provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "./dns-adapter.js";
import { startReplaceNodeOperation } from "./fleet-operations.js";

const REPLACEMENT_SUFFIX_PATTERN = /^(.*)-r(\d+)$/;

/**
 * Names the replacement node de-fsn-001 -> de-fsn-001-r1 -> de-fsn-001-r2
 * etc. (an already-replaced-once node id matching the suffix pattern bumps
 * the counter instead of doubling it), so operators can see replacement
 * lineage directly in the node id without a separate column for it.
 */
function nextReplacementNodeId(oldNodeId) {
  const match = oldNodeId.match(REPLACEMENT_SUFFIX_PATTERN);
  if (match) return `${match[1]}-r${Number(match[2]) + 1}`;
  return `${oldNodeId}-r1`;
}

/**
 * Phase 12a auto-trigger (functions/api/internal/fleet-tick.js), gated by
 * the caller checking FEATURE_AUTO_NODE_REPLACE. Finds nodes FAILED longer
 * than AUTO_REPLACE_AFTER_FAILED_MS with no existing REPLACE_NODE operation
 * (checked directly against fleet_operations' idempotency_key, not by
 * attempting the insert and catching 23505 -- avoids a noisy unique
 * violation every tick for a node already mid-replacement) and starts one
 * for each, exactly the way the admin route does.
 *
 * Requires FLEET_AUTO_REPLACE_REGION: unlike the admin route, there is no
 * human supplying a provisioning region per call, and region is not stored
 * on any node row. No-ops (logs and returns []) rather than throwing when
 * unconfigured, since this runs inside fleet-tick's shared request
 * alongside unrelated operation advances and account-deletion finalization
 * that must not be interrupted by a misconfiguration here.
 */
export async function autoReplaceFailedNodes(supabase, env) {
  const thresholdMs = Number(env.AUTO_REPLACE_AFTER_FAILED_MS);
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return [];
  const region = env.FLEET_AUTO_REPLACE_REGION;
  if (!region) {
    console.error("node-auto-replace: FLEET_AUTO_REPLACE_REGION is not configured");
    return [];
  }

  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data: candidates, error } = await supabase
    .from("nodes")
    .select("node_id, role, location_id, provider, provider_instance_id, lifecycle_state_changed_at")
    .eq("lifecycle_state", "FAILED")
    .lte("lifecycle_state_changed_at", cutoff);
  if (error) {
    console.error("node-auto-replace: candidate query failed:", error.message);
    return [];
  }
  if (!candidates || candidates.length === 0) return [];

  const candidateIds = candidates.map((n) => n.node_id);
  const keys = candidates.map((n) => `REPLACE_NODE:${n.node_id}`);
  const [
    { data: existingOps, error: opsError },
    { data: failedOwnerOps, error: failedOwnerError },
  ] = await Promise.all([
    supabase.from("fleet_operations").select("idempotency_key").in("idempotency_key", keys),
    // A node whose OWN provisioning attempt (CREATE_NODE, or an earlier
    // REPLACE_NODE that made it the new node) already FAILED never actually
    // served traffic -- it doesn't need "replacement", it needs its own
    // retry or manual cleanup. Without this exclusion, a failed replacement
    // attempt's new node (e.g. de-fsn-001-r1, itself later marked FAILED by
    // failNodeIfBooting/the operation deadline) would get auto-"replaced"
    // in turn, while the real problem node (de-fsn-001) sits forever
    // unaddressed -- its own REPLACE_NODE idempotency key was already
    // consumed by the failed attempt, so it can never be retried by this
    // function again.
    supabase.from("fleet_operations").select("node_id").eq("status", "FAILED").in("node_id", candidateIds),
  ]);
  if (opsError) {
    console.error("node-auto-replace: existing-operation query failed:", opsError.message);
    return [];
  }
  if (failedOwnerError) {
    console.error("node-auto-replace: failed-owner-operation query failed:", failedOwnerError.message);
    return [];
  }
  const alreadyReplacing = new Set((existingOps ?? []).map((o) => o.idempotency_key));
  const neverReadyNodeIds = new Set((failedOwnerOps ?? []).map((o) => o.node_id));

  const started = [];
  for (const oldNode of candidates) {
    const key = `REPLACE_NODE:${oldNode.node_id}`;
    if (alreadyReplacing.has(key)) continue;
    if (!oldNode.provider_instance_id || neverReadyNodeIds.has(oldNode.node_id)) {
      console.error(
        `node-auto-replace: node ${oldNode.node_id} never reached READY (failed provisioning attempt), skipping auto-replace`
      );
      continue;
    }
    if (!oldNode.provider) {
      console.error(`node-auto-replace: node ${oldNode.node_id} has no provider on record, skipping`);
      continue;
    }

    let hostname;
    try {
      getProviderAdapter(oldNode.provider, env);
      if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
      getDnsAdapter(env);
      hostname = nodeHostname(nextReplacementNodeId(oldNode.node_id), env);
    } catch (err) {
      console.error(`node-auto-replace: provisioning not configured for ${oldNode.provider}:`, err.message);
      continue;
    }

    const newNodeId = nextReplacementNodeId(oldNode.node_id);
    const { operation, error: startError } = await startReplaceNodeOperation(supabase, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider: oldNode.provider,
      region,
      hostname,
      oldNodeId: oldNode.node_id,
    });
    if (startError) {
      if (startError.code !== "23505") {
        console.error(`node-auto-replace: failed to start replacement for ${oldNode.node_id}:`, startError.message);
      }
      continue;
    }
    started.push({ oldNodeId: oldNode.node_id, newNodeId, operationId: operation.id });
  }
  return started;
}
