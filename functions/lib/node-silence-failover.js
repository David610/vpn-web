import { canTransitionLifecycle } from "./node-lifecycle.js";
import { HEARTBEAT_INTERVAL_MS, SILENCE_THRESHOLD_MULTIPLIER, isNodeSilent } from "./node-health-transition.js";

/**
 * Phase 8 lazy silence detection, shared by functions/api/agent/heartbeat.js
 * and functions/api/admin/nodes.js so both apply exactly the same rule
 * (isNodeSilent's SILENCE_ELIGIBLE_STATES) and the same write. Caller is
 * responsible for the FEATURE_AUTO_NODE_HEALTH gate.
 *
 * Each write is compare-and-set on the lifecycle_state the caller read,
 * like every other lifecycle writer (admin/nodes/[id]/lifecycle.js,
 * agent/enroll.js, fleet-operations.js): if an admin quarantined or
 * re-enrolled the node between that read and this write, zero rows match
 * and the stale FAILED is simply not applied.
 *
 * @param {object} supabase service-role client
 * @param {Array<{node_id: string, lifecycle_state: string, last_seen_at: string|null}>} nodes
 * @param {number} nowMs
 * @returns {Promise<string[]>} node_ids actually moved to FAILED
 */
export async function failSilentNodes(supabase, nodes, nowMs) {
  const failedNodeIds = [];
  for (const node of nodes) {
    if (!isNodeSilent(node, nowMs, HEARTBEAT_INTERVAL_MS)) continue;
    if (!canTransitionLifecycle(node.lifecycle_state, "FAILED")) continue;

    const { data: moved, error } = await supabase
      .from("nodes")
      .update({ lifecycle_state: "FAILED" })
      .eq("node_id", node.node_id)
      .eq("lifecycle_state", node.lifecycle_state)
      .select("node_id")
      .maybeSingle();
    if (error) {
      console.error("node-silence-failover: FAILED transition failed:", error.message);
      continue;
    }
    if (!moved) continue;
    failedNodeIds.push(node.node_id);

    // Resolved later by the node's own heartbeat (heartbeat.js reconciles
    // node_failed against its resulting lifecycle_state) once it recovers.
    const { error: alertError } = await supabase.from("operational_alerts").insert({
      alert_type: "node_failed",
      severity: "critical",
      dedup_key: `node:${node.node_id}:node_failed`,
      node_id: node.node_id,
      message: `Node ${node.node_id} automatically transitioned to FAILED after no heartbeat for over ${SILENCE_THRESHOLD_MULTIPLIER} heartbeat intervals`,
    });
    if (alertError && alertError.code !== "23505") {
      console.error("node-silence-failover: node_failed alert insert failed:", alertError.message);
    }
  }
  return failedNodeIds;
}
