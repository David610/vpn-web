import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { canTransitionLifecycle } from "../../lib/node-lifecycle.js";
import { evaluateProbeResult, isNodeSilent } from "../../lib/node-health-transition.js";

// Matches the agent's HEARTBEAT_INTERVAL (60s) in main.rs -- keep these in
// sync; a drift here would change what "silent" means without a code change
// on the agent side.
const HEARTBEAT_INTERVAL_MS = 60_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function finitePercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const update = {
    last_seen_at: new Date().toISOString(),
    telemetry_at: new Date().toISOString(),
    agent_version: safeVersion(body.agent_version),
    vpn_version: safeVersion(body.vpn_version),
    singbox_version: safeVersion(body.singbox_version),
    uptime_seconds: nonNegativeInteger(body.uptime_seconds),
    cpu_percent: finitePercent(body.cpu_percent),
    memory_percent: finitePercent(body.memory_percent),
    disk_percent: finitePercent(body.disk_percent),
    network_rx_bps: nonNegativeInteger(body.network_rx_bps),
    network_tx_bps: nonNegativeInteger(body.network_tx_bps),
    configured_users: nonNegativeInteger(body.configured_users),
    active_users_recent:
      body.active_users_recent == null ? null : nonNegativeInteger(body.active_users_recent),
  };
  // observed_revision (spec 54 Phase 6): the agent reports the revision it
  // last successfully applied via vpn-admin apply-revision. Absent/invalid
  // is left out of the update entirely, not coerced to 0 -- an agent still
  // on an old build that doesn't report this yet must never look like it
  // just rolled back to revision zero.
  const observedRevision = nonNegativeInteger(body.observed_revision);
  if (observedRevision != null) update.observed_revision = observedRevision;

  const probeOk = typeof body.probe_ok === "boolean" ? body.probe_ok : null;
  update.last_probe_ok = probeOk;
  update.last_probe_at = new Date().toISOString();

  const { data: currentNode } = await supabaseAdmin
    .from("nodes")
    .select("lifecycle_state, consecutive_probe_failures, consecutive_probe_successes")
    .eq("node_id", nodeId)
    .maybeSingle();

  let transitioned = null;
  if (currentNode) {
    const evalResult = evaluateProbeResult({
      probeOk,
      currentFailures: currentNode.consecutive_probe_failures ?? 0,
      currentSuccesses: currentNode.consecutive_probe_successes ?? 0,
      lifecycleState: currentNode.lifecycle_state,
    });
    update.consecutive_probe_failures = evalResult.failures;
    update.consecutive_probe_successes = evalResult.successes;
    if (
      env.FEATURE_AUTO_NODE_HEALTH === "true" &&
      evalResult.nextState &&
      canTransitionLifecycle(currentNode.lifecycle_state, evalResult.nextState)
    ) {
      update.lifecycle_state = evalResult.nextState;
      transitioned = evalResult.nextState;
    }
  }

  // Null means "collector could not obtain this metric", not zero. Keeping
  // it explicit prevents an unavailable probe from looking healthy.
  const { error } = await supabaseAdmin.from("nodes").update(update).eq("node_id", nodeId);
  if (error) {
    console.error("agent/heartbeat: node update failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }

  // An authenticated heartbeat proves the node holds its permanent key, so
  // the enrollment token agent/enroll.js keeps for idempotent retries has no
  // remaining purpose. Never clear it while PROVISIONING, though: that token
  // was freshly minted for a re-enrollment (admin/nodes/[id]/lifecycle.js)
  // and an old agent still heartbeating must not be able to cancel it.
  const { error: tokenClearError } = await supabaseAdmin
    .from("nodes")
    .update({ enrollment_token_hash: null, enrollment_token_expires_at: null })
    .eq("node_id", nodeId)
    .neq("lifecycle_state", "PROVISIONING")
    .not("enrollment_token_hash", "is", null);
  if (tokenClearError) {
    // Non-fatal: the token still expires on its own TTL.
    console.error("agent/heartbeat: enrollment token clear failed:", tokenClearError.message);
  }

  async function reconcileAlert(kind, active, severity, message) {
    const dedupKey = `node:${nodeId}:${kind}`;
    if (active) {
      const { error: alertError } = await supabaseAdmin.from("operational_alerts").insert({
        alert_type: kind,
        severity,
        dedup_key: dedupKey,
        node_id: nodeId,
        message,
      });
      if (alertError && alertError.code !== "23505") {
        console.error("agent/heartbeat: alert insert failed:", alertError.message);
      }
    } else {
      const { error: resolveError } = await supabaseAdmin
        .from("operational_alerts")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("dedup_key", dedupKey)
        .eq("status", "open");
      if (resolveError) {
        console.error("agent/heartbeat: alert resolve failed:", resolveError.message);
      }
    }
  }

  if (env.FEATURE_AUTO_NODE_HEALTH === "true") {
    const { data: candidateNodes } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state, last_seen_at")
      .in("lifecycle_state", ["READY", "DEGRADED"])
      .neq("node_id", nodeId);
    for (const candidate of candidateNodes ?? []) {
      if (
        isNodeSilent(candidate, Date.now(), HEARTBEAT_INTERVAL_MS) &&
        canTransitionLifecycle(candidate.lifecycle_state, "FAILED")
      ) {
        await supabaseAdmin.from("nodes").update({ lifecycle_state: "FAILED" }).eq("node_id", candidate.node_id);
      }
    }
  }

  await Promise.all([
    reconcileAlert(
      "disk_high",
      update.disk_percent != null && update.disk_percent >= 90,
      "critical",
      `Node ${nodeId} disk usage is at or above 90%`
    ),
    reconcileAlert(
      "memory_high",
      update.memory_percent != null && update.memory_percent >= 95,
      "warning",
      `Node ${nodeId} memory usage is at or above 95%`
    ),
    reconcileAlert(
      "node_degraded",
      transitioned === "DEGRADED",
      "warning",
      `Node ${nodeId} automatically transitioned to DEGRADED after repeated failed health probes`
    ),
    reconcileAlert(
      "node_failed",
      transitioned === "FAILED",
      "critical",
      `Node ${nodeId} automatically transitioned to FAILED`
    ),
  ]);

  return json({ ok: true, node_id: nodeId });
}
