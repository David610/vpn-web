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
