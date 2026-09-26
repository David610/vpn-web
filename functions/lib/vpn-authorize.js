import { buildRouteCandidates, ROUTE_ID_PREFIX } from "./route-candidates.js";
import { loadRouteInputs } from "./route-directory.js";
import { buildCreateUserPayload } from "./device-provisioning.js";

/**
 * POST /v1/vpn/authorize's credential-resolution core (see
 * docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md).
 *
 * Route ids are opaque, content-derived candidate ids from GET /v1/routes
 * (functions/lib/route-candidates.js). Authorization rebuilds the
 * candidate set from current fleet state and resolves the id to the exact
 * physical hop node ids it was signed for. It never reschedules: if the
 * candidate is gone or any of its published metadata changed, the id no
 * longer exists and the client gets 409 route_stale and must refresh its
 * directory. A client can therefore never hold node A's signed metadata
 * while receiving node B's credentials.
 *
 * expires_at is a short, advisory TTL on the *response*, matching the
 * tamara-next contract's example -- it does not mean the underlying
 * vpn_accounts credential itself rotates that fast. Real per-connection
 * rotation needs singbox-vpn changes (Sub-project B2, not this pass).
 */
export const AUTHORIZE_TTL_MS = 15 * 60 * 1000;

const badRequest = (message) => ({ ok: false, status: 400, message });
const stale = () => ({
  ok: false,
  status: 409,
  message: "This route is no longer offered. Refresh routes and try again.",
  code: "route_stale",
});
const unavailable = (message) => ({ ok: false, status: 503, message });

/**
 * Resolves each hop's credential from its existing vpn_accounts identity,
 * enqueueing CREATE_USER for any hop that has none yet. Never returns a
 * partial envelope: if any hop is missing, every missing hop still gets
 * its job enqueued before this returns 503, so a retry a few seconds
 * later has strictly better odds across every hop, not just the first.
 */
async function resolveCredentials(supabaseAdmin, device, entitlement, routeId, nodeIds) {
  const hops = [];
  let missing = false;

  for (const nodeId of nodeIds) {
    const { data, error } = await supabaseAdmin
      .from("vpn_accounts")
      .select("vpn_user_id")
      .eq("device_id", device.id)
      .eq("node_id", nodeId)
      .eq("enabled", true)
      .maybeSingle();
    if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);

    if (data) {
      hops.push({ uuid: data.vpn_user_id });
      continue;
    }

    missing = true;
    const { error: insertError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `authorize:create:${device.id}:${nodeId}`,
      node_id: nodeId,
      job_type: "CREATE_USER",
      vpn_account_id: null,
      device_id: device.id,
      payload: buildCreateUserPayload(device, entitlement),
    });
    // 23505: reconcileDeviceProvisioning (or a previous authorize call)
    // already has one in flight for this (device, node) -- already the
    // established "already enqueued" signal (device-provisioning.js's
    // insertJob).
    if (insertError && insertError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${insertError.message}`);
    }
  }

  if (missing) return unavailable("Your credentials are being provisioned. Try again shortly.");
  return {
    ok: true,
    routeId,
    expiresAt: new Date(Date.now() + AUTHORIZE_TTL_MS).toISOString(),
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

export async function authorizeRoute(supabaseAdmin, env, { device, entitlement, routeId }) {
  const id = typeof routeId === "string" ? routeId.trim() : "";
  if (!id || id.length > 160) return badRequest("route_id is required.");
  if (!ROUTE_ID_RE.test(id)) return stale();

  const [inputs, { data: held, error: heldError }] = await Promise.all([
    loadRouteInputs(supabaseAdmin),
    supabaseAdmin.from("device_node_assignments").select("node_id").eq("device_id", device.id),
  ]);
  if (heldError) throw new Error(`device_node_assignments lookup failed: ${heldError.message}`);
  const heldNodeIds = new Set((held ?? []).map((row) => row.node_id));
  const candidate = buildRouteCandidates(inputs, { exhaustive: true, heldNodeIds }).find((route) => route.id === id);
  if (!candidate) return stale();

  await recordAssignment(supabaseAdmin, device.id, candidate);
  return resolveCredentials(supabaseAdmin, device, entitlement, id, candidate.hopNodeIds);
}
