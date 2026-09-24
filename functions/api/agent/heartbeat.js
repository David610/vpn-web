import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";

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

  // Null means "collector could not obtain this metric", not zero. Keeping
  // it explicit prevents an unavailable probe from looking healthy.
  const { error } = await supabaseAdmin.from("nodes").update(update).eq("node_id", nodeId);
  if (error) {
    console.error("agent/heartbeat: node update failed:", error.message);
    return json({ error: "Internal error" }, 500);
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
  ]);

  return json({ ok: true, node_id: nodeId });
}
