import { buildRouteCandidates, ROUTE_ID_PREFIX } from "./route-candidates.js";
import { loadRouteInputs } from "./route-directory.js";
import { decryptSecret, sha256Hex } from "./crypto.js";

/**
 * POST /v1/vpn/authorize's credential-resolution core (see
 * docs/ADR/0003-ephemeral-managed-authorization.md and, for the route
 * binding, docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md).
 *
 * Route ids are opaque, content-derived candidate ids from GET /v1/routes
 * (functions/lib/route-candidates.js). Authorization rebuilds the
 * candidate set from current fleet state and resolves the id to the exact
 * physical hop node ids it was signed for. It never reschedules: if the
 * candidate is gone or any of its published metadata changed, the id no
 * longer exists and the client gets 409 route_stale and must refresh its
 * directory.
 *
 * Credentials are ephemeral (ADR-0003): one pre-provisioned, node-confirmed
 * lease-pool slot per hop, leased atomically by the lease_route_slots RPC
 * (all hops or none). expires_at is the lease's real server-side end: the
 * earliest hop slot's node-enforced valid_until, after which the node's
 * sing-box config no longer accepts that credential for new connections
 * (enforced within one agent poll + apply, control plane or not).
 *
 * Renewal: re-authorizing the same route while the device's lease on it is
 * live (and has at least renewMinLeadSeconds left) EXTENDS that lease --
 * same slots, same credentials, later expires_at -- instead of taking a new
 * slot. Nodes adopt the extension without restarting sing-box, so a client
 * that renews keeps its open connections; only slots that genuinely expire
 * or are revoked rotate (which restarts sing-box and drops every open
 * connection on that node, batched to at most once per rotation window).
 */
export const LEASE_LIMITS = Object.freeze({
  // A slot must have at least this long left to be handed out, so every
  // lease lives between MIN_REMAINING and the node's slot lifetime.
  minRemainingSeconds: 10 * 60,
  // New leases (idempotent replays excluded) per device / per account.
  windowSeconds: 10 * 60,
  perDevice: 20,
  perAccount: 60,
  // Renewal target length: expires_at becomes now + this, floored to each
  // hop node's rotation grid and capped at its slot lifetime.
  renewSeconds: 30 * 60,
  // Below this much time left a lease is not extended (the node might
  // rotate the slot before it adopts the extension); a new lease is taken.
  renewMinLeadSeconds: 60,
});

const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const badRequest = (message) => ({ ok: false, status: 400, message });
const stale = () => ({
  ok: false,
  status: 409,
  message: "This route is no longer offered. Refresh routes and try again.",
  code: "route_stale",
});

// tamara-next's credential envelope (fails closed otherwise): vless-reality
// hops carry `uuid`; hysteria2 hops carry `password`, plus `obfsPassword`
// when the published hop declares hysteria2_obfs_type. The obfs password is
// a per-node secret (node_transport_secrets), not per-lease.
function hopCredential(hop, secret, obfsPassword) {
  if (hop.transport === "vless-reality") return { uuid: secret.vless_uuid };
  if (hop.transport === "hysteria2") {
    return hop.hysteria2_obfs_type ? { password: secret.hysteria2_password, obfsPassword } : { password: secret.hysteria2_password };
  }
  throw new Error(`unsupported hop transport ${hop.transport}`);
}

/**
 * Resolves every obfuscated hysteria2 hop's per-node obfs password BEFORE a
 * lease is taken, so a node that has not reported one yet costs no slot.
 * Returns null if any is missing.
 */
async function loadObfsPasswords(supabaseAdmin, env, candidate) {
  const out = new Map();
  for (let i = 0; i < candidate.hops.length; i += 1) {
    const hop = candidate.hops[i];
    if (hop.transport !== "hysteria2" || !hop.hysteria2_obfs_type) continue;
    const nodeId = candidate.hopNodeIds[i];
    const { data, error } = await supabaseAdmin
      .from("node_transport_secrets")
      .select("hysteria2_obfs_ciphertext, hysteria2_obfs_nonce")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (error) throw new Error(`node_transport_secrets lookup failed: ${error.message}`);
    if (!data?.hysteria2_obfs_ciphertext) return null;
    out.set(i, await decryptSecret(data.hysteria2_obfs_ciphertext, data.hysteria2_obfs_nonce, env.VPN_SECRETS_ENCRYPTION_KEY));
  }
  return out;
}

async function leaseCredentials(supabaseAdmin, env, { device, candidate, clientRequestId }) {
  // Idempotency key: (device, route_id, client request id). Hashed so the
  // raw client value never becomes a lookup key an operator could confuse
  // with anything meaningful; absent => no replay (every call is new).
  const idempotencyKey = clientRequestId
    ? await sha256Hex(`vpn-authorize:v1:${device.id}:${candidate.id}:${clientRequestId}`)
    : null;

  const obfsPasswords = await loadObfsPasswords(supabaseAdmin, env, candidate);
  if (!obfsPasswords) {
    return { ok: false, status: 503, message: "This route is not ready yet. Try again shortly.", code: "route_not_ready" };
  }

  const { data, error } = await supabaseAdmin.rpc("lease_route_slots", {
    p_idempotency_key: idempotencyKey,
    p_device_id: device.id,
    p_account_id: device.account_id,
    p_route_id: candidate.id,
    p_node_ids: candidate.hopNodeIds,
    p_min_remaining_seconds: LEASE_LIMITS.minRemainingSeconds,
    p_device_limit: LEASE_LIMITS.perDevice,
    p_account_limit: LEASE_LIMITS.perAccount,
    p_window_seconds: LEASE_LIMITS.windowSeconds,
    p_renew_seconds: LEASE_LIMITS.renewSeconds,
    p_renew_min_lead_seconds: LEASE_LIMITS.renewMinLeadSeconds,
  });
  if (error) throw new Error(`lease_route_slots failed: ${error.message}`);

  switch (data?.status) {
    case "ok":
      break;
    case "rate_limited":
      return {
        ok: false,
        status: 429,
        message: "Too many connection attempts. Try again shortly.",
        code: "rate_limited",
        retryAfterSeconds: data.retry_after_seconds,
      };
    case "exhausted":
      return {
        ok: false,
        status: 503,
        message: "This route is at capacity right now. Try again shortly or pick another route.",
        code: "capacity_exhausted",
      };
    case "device_inactive":
      return { ok: false, status: 409, message: "This device is not entitled to connect.", code: "not_entitled" };
    case "conflict":
      return { ok: false, status: 409, message: "client_request_id was already used for another route.", code: "idempotency_conflict" };
    default:
      throw new Error(`lease_route_slots returned unexpected status ${data?.status}`);
  }

  if (!Array.isArray(data.hops) || data.hops.length !== candidate.hopNodeIds.length) {
    throw new Error("lease_route_slots returned a hop set that does not match the route");
  }
  const hops = [];
  for (let i = 0; i < data.hops.length; i += 1) {
    const leased = data.hops[i];
    if (leased.node_id !== candidate.hopNodeIds[i]) throw new Error("lease_route_slots returned hops out of order");
    const plaintext = await decryptSecret(leased.credential_ciphertext, leased.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY);
    hops.push(hopCredential(candidate.hops[i], JSON.parse(plaintext), obfsPasswords.get(i)));
  }

  return {
    ok: true,
    routeId: candidate.id,
    expiresAt: new Date(data.expires_at).toISOString(),
    renewed: data.renewed === true,
    credentialEnvelope: { version: 1, hops },
  };
}

const ROUTE_ID_RE = new RegExp(`^${ROUTE_ID_PREFIX}[0-9a-f]{32}$`);

/**
 * Records the resolved hops as the device's sticky assignment so
 * provisioning/reconciliation and capacity accounting follow the route
 * the client actually chose. Written only after the exact candidate was
 * resolved; never used to *choose* the hops.
 */
async function recordAssignment(supabaseAdmin, deviceId, candidate) {
  const hopRoles = candidate.mode === "privacy_plus" ? ["RELAY", "EXIT"] : ["EXIT"];
  const rows = candidate.hopNodeIds.map((nodeId, index) => ({ device_id: deviceId, node_id: nodeId, hop: hopRoles[index] }));
  const { error } = await supabaseAdmin.from("device_node_assignments").upsert(rows, { onConflict: "device_id,hop" });
  if (error) throw new Error(`device_node_assignments upsert failed: ${error.message}`);
  if (candidate.mode === "fast") {
    const { error: deleteError } = await supabaseAdmin
      .from("device_node_assignments")
      .delete()
      .eq("device_id", deviceId)
      .eq("hop", "RELAY");
    if (deleteError) throw new Error(`device_node_assignments delete failed: ${deleteError.message}`);
  }
}

export async function authorizeRoute(supabaseAdmin, env, { device, routeId, clientRequestId = null }) {
  const id = typeof routeId === "string" ? routeId.trim() : "";
  if (!id || id.length > 160) return badRequest("route_id is required.");
  if (clientRequestId !== null && clientRequestId !== undefined && !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
    return badRequest("client_request_id must be 8-64 characters of [A-Za-z0-9_-].");
  }
  if (!ROUTE_ID_RE.test(id)) return stale();

  const [inputs, { data: held, error: heldError }] = await Promise.all([
    loadRouteInputs(supabaseAdmin),
    supabaseAdmin.from("device_node_assignments").select("node_id").eq("device_id", device.id),
  ]);
  if (heldError) throw new Error(`device_node_assignments lookup failed: ${heldError.message}`);
  const heldNodeIds = new Set((held ?? []).map((row) => row.node_id));
  const candidate = buildRouteCandidates(inputs, { exhaustive: true, heldNodeIds }).find((route) => route.id === id);
  if (!candidate) return stale();

  const result = await leaseCredentials(supabaseAdmin, env, { device, candidate, clientRequestId: clientRequestId ?? null });
  // Only a granted lease moves the sticky assignment.
  if (result.ok) await recordAssignment(supabaseAdmin, device.id, candidate);
  return result;
}
