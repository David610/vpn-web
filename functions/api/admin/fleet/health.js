import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson } from "../../../lib/admin-fleet.js";

const NODE_COLUMNS =
  "node_id, role, lifecycle_state, lifecycle_state_changed_at, failed_reason, last_seen_at, revoked_at, retired_at, " +
  "last_probe_at, last_probe_ok, consecutive_probe_failures, consecutive_probe_successes, " +
  "capacity_mbps, max_sessions, configured_users, active_users_recent, cpu_percent, memory_percent, " +
  "desired_revision, observed_revision, agent_version, vpn_version, singbox_version, " +
  "bootstrap_stage, bootstrap_status, bootstrap_updated_at, provider, hostname, locations(display_name, country_code)";

const num = (v) => (v == null ? null : Number(v));

/**
 * Per-node health, probe state, capacity, desired-vs-observed revision and
 * versions, plus recent node lifecycle/probe events from the audit log and
 * recent revision history (metadata only -- revision config is never sent).
 */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  try {
    const [nodesRes, assignRes, revRes, eventsRes] = await Promise.all([
      supabase.from("nodes").select(NODE_COLUMNS),
      supabase.from("device_node_assignments").select("node_id"),
      supabase.from("node_revisions").select("node_id, revision, reason, created_at").order("created_at", { ascending: false }).limit(50),
      supabase
        .from("admin_audit_log")
        .select("id, action, target_id, metadata, created_at")
        .eq("target_type", "node")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    for (const r of [nodesRes, assignRes, revRes, eventsRes]) if (r.error) throw new Error(r.error.message);

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
      events: (eventsRes.data ?? []).map((e) => ({ id: e.id, action: e.action, nodeId: e.target_id, metadata: e.metadata ?? {}, createdAt: e.created_at })),
    });
  } catch (err) {
    console.error("admin/fleet/health:", err.message);
    return fleetJson({ error: "Internal error" }, 500);
  }
}
