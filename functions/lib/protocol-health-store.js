/**
 * Persists an agent's protocol_probe report (see protocol-health.js for the
 * rules). Called from agent/heartbeat.js before the node's own health
 * evaluation, so that evaluation sees fresh protocol counters.
 */
import { canTransitionLifecycle } from "./node-lifecycle.js";
import {
  evaluateProtocolHealth,
  MAX_ROWS_PER_TARGET,
  probeResultRows,
  RETENTION_HOURS,
  summarizeForTarget,
  targetVerdict,
} from "./protocol-health.js";

const TARGET_COLUMNS =
  "node_id, lifecycle_state, failed_reason, consecutive_probe_failures, protocol_probe_failures, protocol_probe_successes, last_peer_probe_at, protocol_health";

export async function applyProtocolReport({ supabase, reporterNodeId, report, autoHealth, nowMs = Date.now() }) {
  const observedAt = new Date(nowMs).toISOString();
  const transitions = [];

  const rows = probeResultRows(reporterNodeId, report, observedAt);
  if (rows.length > 0) {
    const { error } = await supabase.from("node_probe_results").insert(rows);
    if (error) console.error("protocol-health: insert failed:", error.message);
  }

  const byTarget = new Map();
  for (const r of report.results) {
    if (!byTarget.has(r.targetNodeId)) byTarget.set(r.targetNodeId, []);
    byTarget.get(r.targetNodeId).push(r);
  }

  for (const [targetId, results] of byTarget) {
    const { data: target, error: readError } = await supabase
      .from("nodes")
      .select(TARGET_COLUMNS)
      .eq("node_id", targetId)
      .maybeSingle();
    if (readError || !target) continue;
    // A self report may only describe the reporter itself.
    const scoped = results.filter((r) => r.vantage === "peer" || targetId === reporterNodeId);
    const verdict = targetVerdict(scoped, { lastPeerProbeAt: target.last_peer_probe_at, nowMs });

    const update = {};
    if (scoped.some((r) => r.vantage === "peer")) update.last_peer_probe_at = observedAt;
    if (verdict) {
      const decision = evaluateProtocolHealth({
        ok: verdict.ok,
        currentFailures: target.protocol_probe_failures ?? 0,
        currentSuccesses: target.protocol_probe_successes ?? 0,
        lifecycleState: target.lifecycle_state,
        failedReason: target.failed_reason,
        clashFailures: target.consecutive_probe_failures ?? 0,
      });
      update.protocol_probe_failures = decision.failures;
      update.protocol_probe_successes = decision.successes;
      update.protocol_health = summarizeForTarget(target.protocol_health, scoped, verdict.vantage, reporterNodeId, observedAt);
      update.protocol_health_at = observedAt;
      if (autoHealth && decision.nextState && canTransitionLifecycle(target.lifecycle_state, decision.nextState)) {
        transitions.push({ targetId, from: target.lifecycle_state, to: decision.nextState });
      }
    }
    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from("nodes").update(update).eq("node_id", targetId);
      if (error) console.error("protocol-health: node update failed:", error.message);
    }

    const { error: pruneError } = await supabase.rpc("prune_node_probe_results", {
      p_target_node_id: targetId,
      p_keep_hours: RETENTION_HOURS,
      p_max_rows: MAX_ROWS_PER_TARGET,
    });
    if (pruneError) console.error("protocol-health: prune failed:", pruneError.message);
  }

  for (const t of transitions) {
    // Compare-and-set, like heartbeat.js: a concurrent admin action wins.
    const { error } = await supabase
      .from("nodes")
      .update({ lifecycle_state: t.to, lifecycle_state_changed_at: observedAt, failed_reason: null })
      .eq("node_id", t.targetId)
      .eq("lifecycle_state", t.from)
      .select("node_id")
      .maybeSingle();
    if (error) console.error("protocol-health: transition failed:", error.message);
  }

  return { rows: rows.length, transitions };
}
