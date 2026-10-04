import { getAccountForUser } from "../../../../lib/accounts.js";
import { runAccountAction } from "../../../../lib/account-http.js";
import { COMPATIBILITY_LIFETIME_MS, COMPATIBILITY_OVERLAP_MS, mintCompatibilityCredentials } from "../../../../lib/external-credentials.js";

export async function onRequestPost(context) {
  return runAccountAction(context, "external-device credential rotation", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "External device not found" } };
    const { data: device, error: deviceError } = await db.from("external_vpn_devices")
      .select("device_id,desired_route_id").eq("device_id", context.params.id).eq("account_id", account.accountId).maybeSingle();
    if (deviceError) throw new Error(`external device lookup failed: ${deviceError.message}`);
    if (!device) return { status: 404, body: { error: "External device not found" } };
    const { data: route, error: routeError } = await db.from("logical_routes")
      .select("privacy_class").eq("id", device.desired_route_id).maybeSingle();
    if (routeError) throw new Error(`route lookup failed: ${routeError.message}`);
    // mintCompatibilityCredentials mints by count, not enforcement -- the
    // RPC's own route_unavailable check (same as creation) is what's
    // actually authoritative if the route turned out to be disabled or
    // gone since this device was created.
    const credentials = await mintCompatibilityCredentials(context.env, route?.privacy_class);
    const { data, error } = await db.rpc("rotate_compatibility_credential", {
      p_device_id: context.params.id, p_account_id: account.accountId, p_credentials: credentials,
      p_valid_until: new Date(Date.now() + COMPATIBILITY_LIFETIME_MS).toISOString(),
      p_overlap_seconds: Math.floor(COMPATIBILITY_OVERLAP_MS / 1000),
    });
    if (error) throw new Error(`credential rotation failed: ${error.message}`);
    return data ? { status: 202, body: { rotating: true } } : { status: 404, body: { error: "External device not found" } };
  });
}
