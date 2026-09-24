import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { writeAdminAudit } from "../../lib/admin-audit.js";
import { sha256Hex } from "../../lib/crypto.js";
import { generateHexSecret, ENROLLMENT_TOKEN_TTL_MS } from "../../lib/node-enrollment.js";
import { getProviderAdapter } from "../../lib/provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "../../lib/dns-adapter.js";
import { startCreateNodeOperation, advanceOperation } from "../../lib/fleet-operations.js";
import { fleetContext } from "../../lib/fleet-context.js";

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

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Node enrollment (spec §20, §54 Phase 3): creates a PROVISIONING node
 * with no credential and a short-lived, single-use enrollment token —
 * the admin never sees or generates the node's actual API key, and no
 * root SSH or service-role key touches the new VPS. The raw token is
 * returned exactly once; only its hash is stored (nodes.enrollment_token_hash).
 * functions/api/agent/enroll.js is the only other place that ever sees it.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") {
    return jsonResponse({ error: "Read-only admins cannot perform this action" }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return jsonResponse(
      { error: "nodeId must be lowercase alphanumeric/hyphen, 2-63 characters" },
      400
    );
  }
  if (body?.role !== undefined && body.role !== "EXIT" && body.role !== "RELAY") {
    return jsonResponse({ error: "role must be EXIT or RELAY" }, 400);
  }
  const role = body?.role ?? "EXIT";
  const locationId = typeof body?.locationId === "string" && body.locationId ? body.locationId : null;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (locationId !== null && !UUID_PATTERN.test(locationId)) {
    return jsonResponse({ error: "locationId must be a UUID" }, 400);
  }
  // `provider` opts into automated provisioning (spec 54 Phase 4). Omitting
  // it keeps today's manual flow: an admin stands up the VPS by hand and
  // pastes the returned enrollmentToken into its bootstrap themselves.
  // `region` is the provider's own datacenter identifier (e.g. Hetzner's
  // "fsn1"), a different concept from locationId's customer-facing
  // locations row -- see provider-adapter.js's interface comment.
  const provider = typeof body?.provider === "string" && body.provider ? body.provider : null;
  const region = typeof body?.region === "string" && body.region ? body.region : null;
  if (provider && !region) {
    return jsonResponse({ error: "region is required when provider is set" }, 400);
  }

  if (provider) {
    return createProviderNode({ env, supabaseAdmin, admin, nodeId, role, locationId, provider, region });
  }

  // Manual flow: an admin stands the VPS up by hand and runs the node
  // bootstrap with the returned token (docs/NODE_BOOTSTRAP.md).
  try {
    const enrollmentToken = generateHexSecret();
    const enrollmentTokenHash = await sha256Hex(enrollmentToken);
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS).toISOString();

    const { error: insertError } = await supabaseAdmin.from("nodes").insert({
      node_id: nodeId,
      role,
      location_id: locationId,
      lifecycle_state: "PROVISIONING",
      enrollment_token_hash: enrollmentTokenHash,
      enrollment_token_expires_at: expiresAt,
    });
    if (insertError) return insertErrorResponse(insertError);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.create_pending_node",
      targetType: "node",
      targetId: nodeId,
      metadata: { role, location_id: locationId, provider: null },
    });

    return jsonResponse({ ok: true, nodeId, enrollmentToken, expiresAt }, 201);
  } catch (err) {
    console.error("admin/nodes POST: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}

function insertErrorResponse(insertError) {
  if (insertError.code === "23505") {
    return jsonResponse({ error: "A node with this id already exists" }, 409);
  }
  if (insertError.code === "23503") {
    return jsonResponse({ error: "locationId does not exist" }, 400);
  }
  throw new Error(`nodes insert failed: ${insertError.message}`);
}

/**
 * Automated flow (spec 54 Phase 4): registers the node and a resumable
 * CREATE_NODE operation, then advances it inline once for fast feedback.
 * Everything after that -- server creation retries, DNS, waiting for the
 * node to enroll and bootstrap, readiness probes, READY -- is driven by the
 * reconciler (functions/api/internal/fleet-tick.js). The enrollment token
 * is minted inside the operation and handed only to the provider's
 * user_data; it is never returned to the admin's browser.
 */
async function createProviderNode({ env, supabaseAdmin, admin, nodeId, role, locationId, provider, region }) {
  let hostname;
  try {
    getProviderAdapter(provider, env);
    hostname = nodeHostname(nodeId, env);
    if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
    getDnsAdapter(env);
  } catch (err) {
    console.error("admin/nodes POST: fleet provisioning not configured:", err.message);
    return jsonResponse({ error: `Provider ${provider} is not available` }, 400);
  }

  try {
    const { operation, error } = await startCreateNodeOperation(supabaseAdmin, {
      nodeId,
      role,
      locationId,
      provider,
      region,
      hostname,
    });
    if (error) return insertErrorResponse(error);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.create_node",
      targetType: "node",
      targetId: nodeId,
      metadata: { role, location_id: locationId, provider, region, operation_id: operation.id, hostname },
    });

    let progress = null;
    try {
      progress = await advanceOperation(fleetContext(supabaseAdmin, env), operation);
    } catch (err) {
      // Not an error for the caller: the reconciler resumes the operation.
      console.error("admin/nodes POST: inline advance failed:", err.message);
    }

    return jsonResponse(
      { ok: true, nodeId, hostname, operationId: operation.id, progress },
      202
    );
  } catch (err) {
    console.error("admin/nodes POST: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
