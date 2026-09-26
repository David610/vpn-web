import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { canTransitionLifecycle } from "../../lib/node-lifecycle.js";
import { evaluateProbeResult, SILENCE_ELIGIBLE_STATES } from "../../lib/node-health-transition.js";
import { failSilentNodes } from "../../lib/node-silence-failover.js";
import { protocolAllowsRecovery, sanitizeProtocolReport } from "../../lib/protocol-health.js";
import { applyProtocolReport } from "../../lib/protocol-health-store.js";

const MAX_HEARTBEAT_BYTES = 64 * 1024;

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

  // Bound the payload before parsing (protocol_probe makes it larger than
  // it used to be; 32 results are well under 64 KiB).
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_HEARTBEAT_BYTES) return json({ error: "Payload too large" }, 413);
    body = JSON.parse(text);
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
  // last_probe_at is when a probe result last actually arrived, not when
  // the node was last heard from (that is last_seen_at/telemetry_at). A
  // node with no Clash API configured therefore keeps it null.
  if (probeOk !== null) update.last_probe_at = new Date().toISOString();

  const autoHealth = env.FEATURE_AUTO_NODE_HEALTH === "true";

  // Phase 4 protocol probes (REALITY/Hysteria2 handshakes measured by
  // this node against peers and itself). Applied first so the node's own
  // evaluation below sees current protocol counters. Never fatal: a bad
  // report must not cost the heartbeat.
  const protocolReport = sanitizeProtocolReport(body.protocol_probe);
  if (protocolReport) {
    if (protocolReport.tlsInsecure) {
      console.warn(`agent/heartbeat: node ${nodeId} runs protocol probes with tls_insecure_for_tests; hysteria2 results ignored`);
    }
    if (protocolReport.certDays !== null) update.hysteria2_cert_days = protocolReport.certDays;
    try {
      await applyProtocolReport({ supabase: supabaseAdmin, reporterNodeId: nodeId, report: protocolReport, autoHealth });
    } catch (err) {
      console.error("agent/heartbeat: protocol report failed:", err?.message ?? err);
    }
  }

  const { data: currentNode } = await supabaseAdmin
    .from("nodes")
    .select("lifecycle_state, consecutive_probe_failures, consecutive_probe_successes, failed_reason, protocol_probe_failures")
    .eq("node_id", nodeId)
    .maybeSingle();

  let nextState = null;
  if (currentNode) {
    const evalResult = evaluateProbeResult({
      probeOk,
      currentFailures: currentNode.consecutive_probe_failures ?? 0,
      currentSuccesses: currentNode.consecutive_probe_successes ?? 0,
      lifecycleState: currentNode.lifecycle_state,
      failedReason: currentNode.failed_reason,
    });
    update.consecutive_probe_failures = evalResult.failures;
    update.consecutive_probe_successes = evalResult.successes;
    // DEGRADED -> READY also needs protocol evidence to be passing (or
    // absent): a healthy Clash probe must not undo a peer-observed
    // REALITY/Hysteria2 failure.
    const blockedByProtocol =
      evalResult.nextState === "READY" &&
      currentNode.lifecycle_state === "DEGRADED" &&
      !protocolAllowsRecovery(currentNode);
    if (
      autoHealth &&
      evalResult.nextState &&
      !blockedByProtocol &&
      canTransitionLifecycle(currentNode.lifecycle_state, evalResult.nextState)
    ) {
      nextState = evalResult.nextState;
    }
  }

  // Null means "collector could not obtain this metric", not zero. Keeping
  // it explicit prevents an unavailable probe from looking healthy.
  // Telemetry and streak counters are written unconditionally and never
  // carry lifecycle_state: losing the lifecycle race below must not also
  // lose this heartbeat's data.
  const { error } = await supabaseAdmin.from("nodes").update(update).eq("node_id", nodeId);
  if (error) {
    console.error("agent/heartbeat: node update failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }

  // The lifecycle_state this node is in after this request, for alert
  // reconciliation below; undefined when it cannot be known.
  let resultingState = currentNode?.lifecycle_state;
  if (nextState) {
    // Compare-and-set on the state evaluateProbeResult decided from, like
    // admin/nodes/[id]/lifecycle.js: an admin QUARANTINE (or any other
    // transition) landing between our read and this write must win. Zero
    // rows just means this tick's automated transition did not apply.
    const { data: moved, error: transitionError } = await supabaseAdmin
      .from("nodes")
      .update({ lifecycle_state: nextState, lifecycle_state_changed_at: new Date().toISOString(), failed_reason: null })
      .eq("node_id", nodeId)
      .eq("lifecycle_state", currentNode.lifecycle_state)
      .select("node_id")
      .maybeSingle();
    if (transitionError) {
      console.error("agent/heartbeat: lifecycle transition failed:", transitionError.message);
      resultingState = undefined;
    } else {
      // Lost the race: the state is now whatever someone else set.
      resultingState = moved ? nextState : undefined;
    }
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

  if (autoHealth) {
    // The .in() filter is only a query-size optimization derived from the
    // same shared constant; isNodeSilent (inside failSilentNodes) is the
    // actual eligibility rule, identical to admin/nodes.js's.
    const { data: candidateNodes } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state, last_seen_at")
      .in("lifecycle_state", [...SILENCE_ELIGIBLE_STATES])
      .neq("node_id", nodeId);
    await failSilentNodes(supabaseAdmin, candidateNodes ?? [], Date.now());
  }

  // Health alerts track the node's resulting state, not whether a
  // transition happened on this particular request: node_degraded stays
  // open for as long as the node is DEGRADED and resolves once it leaves.
  // node_failed is raised by failSilentNodes (silence is the only way into
  // FAILED) and resolved here on the node's first heartbeat out of FAILED.
  // Skipped entirely when the resulting state is unknown (lost race).
  const healthAlerts =
    resultingState === undefined
      ? []
      : [
          reconcileAlert(
            "node_degraded",
            autoHealth && resultingState === "DEGRADED",
            "warning",
            `Node ${nodeId} is DEGRADED after repeated failed data-plane health probes`
          ),
          reconcileAlert(
            "node_failed",
            autoHealth && resultingState === "FAILED",
            "critical",
            `Node ${nodeId} is FAILED`
          ),
        ];

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
    ...healthAlerts,
  ]);

  return json({ ok: true, node_id: nodeId });
}
