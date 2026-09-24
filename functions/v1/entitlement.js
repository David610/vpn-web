import { ensureSessionDevice } from "../lib/account-service.js";
import { loadDeviceEntitlements } from "../lib/subscriptions.js";
import { withV1User, v1Json } from "../lib/v1-http.js";

/**
 * GET /v1/entitlement — whether THIS device may connect: its subscription
 * is live and the device is within that subscription's capacity.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/entitlement", async (db, user, sessionId) => {
    const device = await ensureSessionDevice(db, context.env, user, sessionId);
    const { data: row, error } = await db
      .from("devices")
      .select("id, account_id, status, subscription_id, created_at")
      .eq("id", device.id)
      .single();
    if (error) throw new Error(`devices lookup failed: ${error.message}`);
    const { data: devices, error: listError } = await db
      .from("devices")
      .select("id, status, subscription_id, created_at")
      .eq("account_id", row.account_id);
    if (listError) throw new Error(`devices lookup failed: ${listError.message}`);
    const entitlement = (await loadDeviceEntitlements(db, row.account_id, devices ?? [])).get(row.id);
    if (!entitlement) {
      return v1Json({
        status: "inactive",
        reason: row.subscription_id == null ? "no_subscription_place" : "subscription_inactive",
      });
    }
    return v1Json({
      status: "active",
      valid_until: entitlement.clearExpiry ? null : entitlement.serviceExpiresAt,
    });
  });
