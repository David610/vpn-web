import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function classify(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  // Agent heartbeat cadence is 60 seconds. Give one missed heartbeat before
  // declaring a healthy node offline.
  if (ageMs < 90_000) return "online";
  if (ageMs < 180_000) return "degraded";
  return "offline";
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin
      .from("nodes")
      .select(
        "node_id, last_seen_at, revoked_at, telemetry_at, agent_version, vpn_version, singbox_version, uptime_seconds, cpu_percent, memory_percent, disk_percent, network_rx_bps, network_tx_bps, configured_users, active_users_recent"
      );
    if (error) throw new Error(`nodes query failed: ${error.message}`);

    const nodes = (data ?? []).map((n) => ({
      nodeId: n.node_id,
      status: n.revoked_at ? "revoked" : classify(n.last_seen_at),
      lastSeenAt: n.last_seen_at,
      telemetryAt: n.telemetry_at,
      revokedAt: n.revoked_at,
      agentVersion: n.agent_version,
      vpnVersion: n.vpn_version,
      singboxVersion: n.singbox_version,
      uptimeSeconds: n.uptime_seconds == null ? null : Number(n.uptime_seconds),
      cpuPercent: n.cpu_percent,
      memoryPercent: n.memory_percent,
      diskPercent: n.disk_percent,
      networkRxBps: n.network_rx_bps == null ? null : Number(n.network_rx_bps),
      networkTxBps: n.network_tx_bps == null ? null : Number(n.network_tx_bps),
      configuredUsers: n.configured_users,
      activeUsersRecent: n.active_users_recent,
    }));

    return jsonResponse({ nodes });
  } catch (err) {
    console.error("admin/nodes: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
