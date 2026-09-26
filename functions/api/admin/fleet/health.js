import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson } from "../../../lib/admin-fleet.js";

const NODE_COLUMNS =
  "node_id, role, lifecycle_state, lifecycle_state_changed_at, failed_reason, last_seen_at, revoked_at, retired_at, " +
  "last_probe_at, last_probe_ok, consecutive_probe_failures, consecutive_probe_successes, " +
  "protocol_health, protocol_health_at, protocol_probe_failures, protocol_probe_successes, last_peer_probe_at, " +
  "hysteria2_cert_days, ip_reputation, ip_reputation_checked_at, " +
  "capacity_mbps, max_sessions, configured_users, active_users_recent, cpu_percent, memory_percent, " +
  "desired_revision, observed_revision, agent_version, vpn_version, singbox_version, " +
  "bootstrap_stage, bootstrap_status, bootstrap_updated_at, provider, hostname, locations(display_name, country_code)";

const num = (v) => (v == null ? null : Number(v));

// Whitelist the stored per-protocol summary shape so a future writer that
// stuffs something else into the jsonb cannot leak it through this API.
const SUMMARY_DIMS = ["tcp_connect", "handshake", "https_ipv4", "dns", "ipv6", "egress_ipv4", "egress_ipv6", "egress_ip_match"];
function sanitizeSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const proto of ["reality", "hysteria2"]) {
    const s = raw[proto];
    if (!s || typeof s !== "object") continue;
    const dims = {};
    for (const d of SUMMARY_DIMS) dims[d] = s.dims?.[d] ?? null;
    out[proto] = {
      ok: typeof s.ok === "boolean" ? s.ok : null,
      vantage: s.vantage === "peer" || s.vantage === "self" ? s.vantage : null,
      reporter: typeof s.reporter === "string" ? s.reporter : null,
      at: typeof s.at === "string" ? s.at : null,
      latencyMs: num(s.latencyMs),
      lossPct: num(s.lossPct),
      error: typeof s.error === "string" ? s.error : null,
      dims,
    };
  }
  return out;
}

/**
 * Per-node health, probe state, capacity, desired-vs-observed revision and
 * versions, plus recent node lifecycle/probe events from the audit log and
 * recent revision history (metadata only -- revision config is never sent).
 */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  try {
    const [nodesRes, assignRes, revRes, eventsRes, probesRes] = await Promise.all([
      supabase.from("nodes").select(NODE_COLUMNS),
      supabase.from("device_node_assignments").select("node_id"),
      supabase.from("node_revisions").select("node_id, revision, reason, created_at").order("created_at", { ascending: false }).limit(50),
      supabase
        .from("admin_audit_log")
        .select("id, action, target_id, metadata, created_at")
        .eq("target_type", "node")
        .order("created_at", { ascending: false })
        .limit(100),
      // Recent protocol probe history (per-dimension rows; credentials
      // live in a different table and are never selected here).
      supabase
        .from("node_probe_results")
        .select("id, observed_at, reporter_node_id, target_node_id, vantage, protocol, dimension, ok, value_num, value_text")
        .order("observed_at", { ascending: false })
        .limit(400),
    ]);
    for (const r of [nodesRes, assignRes, revRes, eventsRes, probesRes]) if (r.error) throw new Error(r.error.message);

    const assigned = new Map();
    for (const a of assignRes.data ?? []) assigned.set(a.node_id, (assigned.get(a.node_id) ?? 0) + 1);

    const nodes = (nodesRes.data ?? []).map((n) => {
      const devices = assigned.get(n.node_id) ?? 0;
      const maxSessions = num(n.max_sessions);
      return {
        nodeId: n.node_id,
        role: n.role,
        lifecycleState: n.lifecycle_state,
        lifecycleStateChangedAt: n.lifecycle_state_changed_at ?? null,
        failedReason: n.failed_reason ?? null,
        lastSeenAt: n.last_seen_at ?? null,
        revokedAt: n.revoked_at ?? null,
        retiredAt: n.retired_at ?? null,
        location: n.locations ? `${n.locations.display_name} (${n.locations.country_code})` : null,
        provider: n.provider ?? null,
        hostname: n.hostname ?? null,
        probe: {
          lastAt: n.last_probe_at ?? null,
          lastOk: n.last_probe_ok ?? null,
          consecutiveFailures: num(n.consecutive_probe_failures) ?? 0,
          consecutiveSuccesses: num(n.consecutive_probe_successes) ?? 0,
        },
        protocol: {
          summary: sanitizeSummary(n.protocol_health),
          at: n.protocol_health_at ?? null,
          consecutiveFailures: num(n.protocol_probe_failures) ?? 0,
          consecutiveSuccesses: num(n.protocol_probe_successes) ?? 0,
          lastPeerProbeAt: n.last_peer_probe_at ?? null,
          hysteria2CertDays: num(n.hysteria2_cert_days),
        },
        // Informational only; never part of lifecycle health.
        ipReputation: { value: n.ip_reputation ?? null, checkedAt: n.ip_reputation_checked_at ?? null },
        capacity: {
          assignedDevices: devices,
          maxSessions,
          utilization: maxSessions ? devices / maxSessions : null,
          capacityMbps: num(n.capacity_mbps),
          configuredUsers: num(n.configured_users),
          activeUsersRecent: num(n.active_users_recent),
          cpuPercent: num(n.cpu_percent),
          memoryPercent: num(n.memory_percent),
        },
        revision: {
          desired: Number(n.desired_revision ?? 0),
          observed: Number(n.observed_revision ?? 0),
          inSync: Number(n.desired_revision ?? 0) === Number(n.observed_revision ?? 0),
        },
        versions: { agent: n.agent_version ?? null, vpn: n.vpn_version ?? null, singbox: n.singbox_version ?? null },
        bootstrap: { stage: n.bootstrap_stage ?? null, status: n.bootstrap_status ?? null, updatedAt: n.bootstrap_updated_at ?? null },
      };
    });

    return fleetJson({
      nodes,
      revisions: (revRes.data ?? []).map((r) => ({ nodeId: r.node_id, revision: Number(r.revision), reason: r.reason ?? null, createdAt: r.created_at })),
      probeHistory: (probesRes.data ?? []).map((p) => ({
        id: p.id,
        at: p.observed_at,
        reporter: p.reporter_node_id,
        target: p.target_node_id,
        vantage: p.vantage,
        protocol: p.protocol,
        dimension: p.dimension,
        ok: p.ok ?? null,
        value: p.value_num == null ? null : Number(p.value_num),
        text: p.value_text ?? null,
      })),
      events: (eventsRes.data ?? []).map((e) => ({ id: e.id, action: e.action, nodeId: e.target_id, metadata: e.metadata ?? {}, createdAt: e.created_at })),
    });
  } catch (err) {
    console.error("admin/fleet/health:", err.message);
    return fleetJson({ error: "Internal error" }, 500);
  }
}
