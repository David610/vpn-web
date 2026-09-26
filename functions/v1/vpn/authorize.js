import { ensureSessionDevice } from "../../lib/account-service.js";
import { loadDeviceEntitlements } from "../../lib/subscriptions.js";
import { authorizeRoute } from "../../lib/vpn-authorize.js";
import { readV1Json, withV1User, v1Json, v1Error } from "../../lib/v1-http.js";

/**
 * POST /v1/vpn/authorize -- per-connection pseudonymous credential
 * issuance for a route from GET /v1/routes. Credentials are short-lived
 * lease-pool slots (docs/ADR/0003-ephemeral-managed-authorization.md);
 * route binding per
 * docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md.
 *
 * Body: { route_id, client_request_id? }. Retrying with the same
 * client_request_id for the same route returns the same lease while it is
 * live, so a lost response never burns a second slot.
 */
export async function onRequestPost(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;

  return withV1User(context, "v1/vpn/authorize", async (db, user, sessionId) => {
    const routeId = typeof body.route_id === "string" ? body.route_id.trim() : "";
    if (!routeId) return v1Error(400, "route_id is required.");

    const sessionDevice = await ensureSessionDevice(db, context.env, user, sessionId);
    const { data: device, error: deviceError } = await db
      .from("devices")
      .select("id, account_id, user_id")
      .eq("id", sessionDevice.id)
      .single();
    if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);

    const { data: accountDevices, error: devicesError } = await db
      .from("devices")
      .select("id, status, subscription_id, created_at")
      .eq("account_id", device.account_id);
    if (devicesError) throw new Error(`devices lookup failed: ${devicesError.message}`);

    const entitlement = (await loadDeviceEntitlements(db, device.account_id, accountDevices ?? [])).get(device.id);
    if (!entitlement) return v1Error(409, "This device is not entitled to connect.", "not_entitled");

    const clientRequestId = body.client_request_id ?? null;
    if (clientRequestId !== null && typeof clientRequestId !== "string") {
      return v1Error(400, "client_request_id must be a string.");
    }
    const result = await authorizeRoute(db, context.env, { device, routeId, clientRequestId });
    if (!result.ok) {
      const response = v1Error(result.status, result.message, result.code);
      if (result.retryAfterSeconds) response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }
    return v1Json({
      route_id: result.routeId,
      expires_at: result.expiresAt,
      credential_envelope: result.credentialEnvelope,
    });
  });
}
