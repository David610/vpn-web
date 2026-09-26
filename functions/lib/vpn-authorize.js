import { scheduleNodeForDevice, scheduleDoubleHopForDevice } from "./scheduler.js";
import { buildCreateUserPayload } from "./device-provisioning.js";

/**
 * POST /v1/vpn/authorize's credential-resolution core (see
 * docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md).
 *
 * Route ids are Sub-project A's deterministic, unstored ids
 * (`${cc}-fast` / `${entryCc}-${exitCc}-privacy`, 2-letter lowercase
 * country codes) -- there is no `routes` table row to join against, so
 * this parses the id back into location(s) and re-runs the same
 * scheduler placement GET /v1/routes' rendering already trusts.
 *
 * expires_at is a short, advisory TTL on the *response*, matching the
 * tamara-next contract's example -- it does not mean the underlying
 * vpn_accounts credential itself rotates that fast. Real per-connection
 * rotation needs singbox-vpn changes (Sub-project B2, not this pass).
 */
export const AUTHORIZE_TTL_MS = 15 * 60 * 1000;

const FAST_RE = /^([a-z]{2})-fast$/;
const PRIVACY_RE = /^([a-z]{2})-([a-z]{2})-privacy$/;

const badRequest = (message) => ({ ok: false, status: 400, message });
const notFound = (message) => ({ ok: false, status: 409, message, code: "route_not_found" });
const unavailable = (message) => ({ ok: false, status: 503, message });

async function findEnabledLocationId(supabaseAdmin, countryCode) {
  const { data, error } = await supabaseAdmin
    .from("locations")
    .select("id")
    .eq("country_code", countryCode.toUpperCase())
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`locations lookup failed: ${error.message}`);
  return data?.id ?? null;
}

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

export async function authorizeRoute(supabaseAdmin, env, { device, entitlement, routeId }) {
  const id = typeof routeId === "string" ? routeId.trim() : "";
  if (!id || id.length > 160) return badRequest("route_id is required.");

  const fastMatch = FAST_RE.exec(id);
  const privacyMatch = fastMatch ? null : PRIVACY_RE.exec(id);
  if (!fastMatch && !privacyMatch) return badRequest("route_id has an unrecognized format.");

  if (fastMatch) {
    const exitLocationId = await findEnabledLocationId(supabaseAdmin, fastMatch[1]);
    if (!exitLocationId) return notFound("This route is not currently offered.");
    const nodeId = await scheduleNodeForDevice(supabaseAdmin, { deviceId: device.id, exitLocationId });
    if (!nodeId) return unavailable("No server is currently available for this route.");
    return resolveCredentials(supabaseAdmin, device, entitlement, id, [nodeId]);
  }

  const [entryLocationId, exitLocationId] = await Promise.all([
    findEnabledLocationId(supabaseAdmin, privacyMatch[1]),
    findEnabledLocationId(supabaseAdmin, privacyMatch[2]),
  ]);
  if (!entryLocationId || !exitLocationId) return notFound("This route is not currently offered.");
  const placed = await scheduleDoubleHopForDevice(supabaseAdmin, { deviceId: device.id, entryLocationId, exitLocationId });
  if (!placed) return unavailable("No server is currently available for this route.");
  return resolveCredentials(supabaseAdmin, device, entitlement, id, [placed.relayNodeId, placed.exitNodeId]);
}
