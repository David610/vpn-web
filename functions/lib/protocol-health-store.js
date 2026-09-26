/**
 * Persists an agent's protocol_probe report (see protocol-health.js for the
 * rules). Called from agent/heartbeat.js before the node's own health
 * evaluation, so that evaluation sees fresh protocol counters.
 */
import { canTransitionLifecycle } from "./node-lifecycle.js";
import {
  choosePeers,
  evaluateProtocolHealth,
  PEER_FRESH_MS,
  PROBING_STATES,
  MAX_ROWS_PER_TARGET,
  probeResultRows,
  RETENTION_HOURS,
  summarizeForTarget,
  targetVerdict,
} from "./protocol-health.js";

const TARGET_COLUMNS =
  "node_id, lifecycle_state, failed_reason, consecutive_probe_failures, protocol_probe_failures, protocol_probe_successes, last_peer_probe_at, protocol_health";

export async function applyProtocolReport({ supabase, reporterNodeId, report: rawReport, autoHealth, nowMs = Date.now() }) {
  const observedAt = new Date(nowMs).toISOString();
  let report = rawReport;
  const transitions = [];

  // Authorization: only an active (probing) reporter counts at all, and
  // its peer results only about targets the control plane actually
  // assigned it (current or previous hourly rotation). Otherwise one
  // buggy/compromised agent could report on any node in the fleet.
  const { data: fleet, error: fleetError } = await supabase
    .from("nodes")
    .select("node_id, lifecycle_state")
    .in("lifecycle_state", PROBING_STATES)
    .is("revoked_at", null);
  if (fleetError) {
    console.error("protocol-health: fleet read failed:", fleetError.message);
    return { rows: 0, transitions };
  }
  const fleetNodes = fleet ?? [];
  if (!fleetNodes.some((n) => n.node_id === reporterNodeId)) return { rows: 0, transitions };
  const others = fleetNodes.filter((n) => n.node_id !== reporterNodeId);
  const assigned = new Set([
    ...choosePeers(reporterNodeId, others, nowMs).map((p) => p.node_id),
    ...choosePeers(reporterNodeId, others, nowMs - 3_600_000).map((p) => p.node_id),
  ]);
  report = {
    ...report,
    results: report.results.filter((r) =>
      r.vantage === "self" ? r.targetNodeId === reporterNodeId : assigned.has(r.targetNodeId)
    ),
  };

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
    const scoped = results;
    let verdict = targetVerdict(scoped, { lastPeerProbeAt: target.last_peer_probe_at, nowMs });
    // Quorum-lite: one peer's failure does not count while any OTHER peer
    // currently sees the target passing (a single bad vantage point, or a
    // lying node, cannot DEGRADE a node its other peers can reach).
    if (verdict && !verdict.ok && verdict.vantage === "peer") {
      const contradicted = await otherPeerPassing(supabase, targetId, reporterNodeId, nowMs);
      if (contradicted) verdict = null;
    }

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

/** True when a reporter other than `reporterId` has a fresh passing peer verdict on `targetId`. */
async function otherPeerPassing(supabase, targetId, reporterId, nowMs) {
  const since = new Date(nowMs - PEER_FRESH_MS).toISOString();
  const { data, error } = await supabase
    .from("node_probe_results")
    .select("reporter_node_id, ok, observed_at")
    .eq("target_node_id", targetId)
    .eq("dimension", "useful_egress")
    .eq("vantage", "peer")
    .neq("reporter_node_id", reporterId)
    .gte("observed_at", since)
    .order("observed_at", { ascending: false })
    .limit(200);
  if (error) {
    // Fail safe: without corroboration data, do not count the failure.
    console.error("protocol-health: quorum read failed:", error.message);
    return true;
  }
  const latest = new Map();
  for (const row of data ?? []) if (!latest.has(row.reporter_node_id)) latest.set(row.reporter_node_id, row.ok);
  return [...latest.values()].some((ok) => ok === true);
}
