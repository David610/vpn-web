import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function classify(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  // Heartbeats are every 60s. Give one missed heartbeat before degrading
  // and two before declaring the node offline.
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
    const todayUtc = new Date().toISOString().slice(0, 10);
    const [
      { data, error },
      { data: samples, error: samplesError },
      { data: daily, error: dailyError },
    ] = await Promise.all([
      supabaseAdmin
        .from("nodes")
        .select(
          "node_id, last_seen_at, revoked_at, telemetry_at, agent_version, vpn_version, singbox_version, uptime_seconds, cpu_percent, memory_percent, disk_percent, network_rx_bps, network_tx_bps, configured_users, active_users_recent, role, lifecycle_state, provider, asn, failure_domain, capacity_mbps, max_sessions, desired_revision, observed_revision, retired_at, locations(display_name, country_code)"
        ),
      supabaseAdmin
        .from("node_traffic_samples")
        .select("node_id, delta_up, delta_down, interval_seconds, connections_open, sampled_at")
        .order("sampled_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("node_traffic_daily")
        .select("node_id, bytes_up, bytes_down")
        .eq("day", todayUtc),
    ]);
    if (error) throw new Error(`nodes query failed: ${error.message}`);
    if (samplesError) throw new Error(`node_traffic_samples query failed: ${samplesError.message}`);
    if (dailyError) throw new Error(`node_traffic_daily query failed: ${dailyError.message}`);

    const latestByNode = new Map();
    for (const sample of samples ?? []) {
      if (!latestByNode.has(sample.node_id)) latestByNode.set(sample.node_id, sample);
    }
    const dailyByNode = new Map((daily ?? []).map((row) => [row.node_id, row]));

    const nodes = (data ?? []).map((node) => {
      const latest = latestByNode.get(node.node_id);
      const today = dailyByNode.get(node.node_id);
      const trafficFresh =
        latest && Date.now() - new Date(latest.sampled_at).getTime() < 120_000;
      const interval = latest?.interval_seconds;

      return {
        nodeId: node.node_id,
        status: node.revoked_at ? "revoked" : classify(node.last_seen_at),
        lastSeenAt: node.last_seen_at ?? null,
        revokedAt: node.revoked_at ?? null,

        // Host-level health from the authenticated 60-second heartbeat.
        telemetryAt: node.telemetry_at ?? null,
        agentVersion: node.agent_version ?? null,
        vpnVersion: node.vpn_version ?? null,
        singboxVersion: node.singbox_version ?? null,
        uptimeSeconds: node.uptime_seconds == null ? null : Number(node.uptime_seconds),
        cpuPercent: node.cpu_percent == null ? null : Number(node.cpu_percent),
        memoryPercent: node.memory_percent == null ? null : Number(node.memory_percent),
        diskPercent: node.disk_percent == null ? null : Number(node.disk_percent),
        networkRxBps: node.network_rx_bps == null ? null : Number(node.network_rx_bps),
        networkTxBps: node.network_tx_bps == null ? null : Number(node.network_tx_bps),
        configuredUsers: node.configured_users == null ? null : Number(node.configured_users),
        activeUsersRecent:
          node.active_users_recent == null ? null : Number(node.active_users_recent),

        // Fleet registry metadata (spec §7/§54 Phase 2). lifecycleState is
        // the desired-state side of the reconciliation model (spec §8):
        // what the control plane intends this node to be doing, set by an
        // admin lifecycle-transition action, not by the heartbeat above.
        role: node.role,
        lifecycleState: node.lifecycle_state,
        location: node.locations
          ? { displayName: node.locations.display_name, countryCode: node.locations.country_code }
          : null,
        provider: node.provider ?? null,
        asn: node.asn == null ? null : Number(node.asn),
        failureDomain: node.failure_domain ?? null,
        capacityMbps: node.capacity_mbps == null ? null : Number(node.capacity_mbps),
        maxSessions: node.max_sessions == null ? null : Number(node.max_sessions),
        desiredRevision: Number(node.desired_revision),
        observedRevision: Number(node.observed_revision),
        retiredAt: node.retired_at ?? null,

        // VPN data-plane totals from sing-box's Clash API. These are per-node
        // because the official sing-box build exposes no reliable per-user
        // attribution.
        traffic: {
          sampledAt: latest?.sampled_at ?? null,
          connectionsOpen: trafficFresh ? latest.connections_open : null,
          bpsUp:
            trafficFresh && interval
              ? Math.round((latest.delta_up * 8) / interval)
              : null,
          bpsDown:
            trafficFresh && interval
              ? Math.round((latest.delta_down * 8) / interval)
              : null,
          todayBytesUp: today?.bytes_up ?? 0,
          todayBytesDown: today?.bytes_down ?? 0,
        },
      };
    });

    return jsonResponse({ nodes });
  } catch (err) {
    console.error("admin/nodes: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
