/**
 * C-01 (docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md):
 * public.device_entitlement(device_id) is the ONE gate that decides whether
 * a device may hold or receive a working VPN credential right now. Every
 * call site that used to compute capacity itself (subscriptions.js's
 * resolveDeviceEntitlements, and identity-lifecycle.js's ad hoc
 * "stillEntitled", which never checked capacity at all) must instead call
 * this and honour its answer -- so a capacity/suspension/deletion rule only
 * has to be correct in one place.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} deviceId
 * @returns {Promise<{ entitled: boolean, subscriptionId: string|null, reason: string }>}
 */
import { getActiveAdminEntitlements, resolveEffectiveEntitlement } from "./accounts.js";
import { getAccountSubscription } from "./subscriptions.js";

export async function checkDeviceEntitlement(supabaseAdmin, deviceId) {
  const { data, error } = await supabaseAdmin.rpc("device_entitlement", { p_device_id: deviceId });
  if (error) throw new Error(`device_entitlement failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { entitled: false, subscriptionId: null, reason: "device_not_found" };
  return {
    entitled: !!row.entitled,
    subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
    reason: row.reason ?? null,
  };
}

/**
 * Phase 3 (docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md):
 * the one full "is this device entitled, and to what" answer for callers
 * that need the billing shape (serviceExpiresAt/clearExpiry/seatLimit), not
 * just the boolean gate. Capacity/suspension/deletion is decided ENTIRELY
 * by public.device_entitlement() (checkDeviceEntitlement above); this only
 * composes the *billing* view (grace period, admin-grant expiry override,
 * seat limit for display) for the subscription/grant device_entitlement()
 * already picked. It never re-derives which subscription a device counts
 * against, and never re-ranks devices against capacity -- that would be
 * exactly the duplication this phase removes.
 *
 * Replaces subscriptions.js's resolveDeviceEntitlements/loadDeviceEntitlements
 * for every caller that only needs ONE device's entitlement
 * (reconcileDeviceProvisioning's per-device loop, /v1/vpn/authorize,
 * /v1/entitlement). Those functions still exist for pickSubscriptionWithRoom
 * (choosing a subscription for a NEW device, before it has a row to gate on)
 * and for account-level aggregate views (getOverview's capacity summary),
 * which are not entitlement decisions.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ id: string, account_id: string }} device
 * @returns {Promise<object|null>} the same shape as accounts.js's
 *   resolveEffectiveEntitlement, or null when the device is not entitled.
 */
export async function resolveDeviceEntitlement(supabaseAdmin, device) {
  const gate = await checkDeviceEntitlement(supabaseAdmin, device.id);
  if (!gate.entitled) return null;

  const grants = await getActiveAdminEntitlements(supabaseAdmin, device.account_id);
  if (gate.subscriptionId) {
    const sub = await getAccountSubscription(supabaseAdmin, device.account_id, Number(gate.subscriptionId));
    // device_entitlement() already confirmed this subscription is live and
    // this device is within its capacity; a missing row here would only
    // mean a race since the RPC ran, so failing closed (no entitlement) is
    // correct rather than silently falling through to the grant path.
    if (!sub) return null;
    return resolveEffectiveEntitlement(sub, grants);
  }
  return resolveEffectiveEntitlement(null, grants);
}
