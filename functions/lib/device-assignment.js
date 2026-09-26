/**
 * Reassigns a device's connection profile — "free" in the billing sense
 * (spec §10): a routing-policy change only, never touches Stripe or seats.
 * Shared by the website (/api/account/devices/:id/assignment) and the
 * Telegram Mini App (/api/telegram/devices/:id/assignment); both return
 * this { status, body } unchanged.
 *
 * device_profile_assignments.device_id is the primary key, so this is an
 * upsert: a device may have at most one active profile. The DB trigger
 * enforce_device_profile_assignment_account (fleet_foundations migration)
 * is the structural guarantee that device and profile share an account,
 * but a raw 23514/trigger exception is not a fit response for an API
 * client, so both sides are checked here first for a clean 400/403.
 */
import { getAccountForUser, getEffectiveEntitlement } from "./accounts.js";
import { reconcileDeviceProvisioning } from "./device-provisioning.js";

const fail = (status, error) => ({ status, body: { error } });

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {object} env
 * @param {{ id: string }} user
 * @param {string} deviceId
 * @param {unknown} profileId
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function assignDeviceProfile(supabaseAdmin, env, user, deviceId, profileId) {
  if (typeof profileId !== "string" || profileId.length === 0) {
    return fail(400, "profileId is required");
  }

  const account = await getAccountForUser(supabaseAdmin, user.id);
  if (!account) throw new Error(`user ${user.id} has no account_members row`);

  const { data: device, error: deviceError } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, user_id, status")
    .eq("id", deviceId)
    .maybeSingle();
  if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);
  if (!device || device.account_id !== account.accountId) return fail(404, "Device not found");
  if (device.user_id !== user.id && account.role !== "owner") {
    return fail(403, "Only the account owner can change another member's device.");
  }
  if (device.status === "REVOKED") return fail(409, "Cannot assign a profile to a revoked device.");

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("connection_profiles")
    .select("id, account_id, enabled")
    .eq("id", profileId)
    .maybeSingle();
  if (profileError) throw new Error(`connection_profiles lookup failed: ${profileError.message}`);
  if (!profile) return fail(404, "Connection profile not found");
  if (profile.account_id !== account.accountId) {
    // Same cross-account invariant the DB trigger enforces; caught here
    // first for a clean 403 rather than a raised trigger exception.
    return fail(403, "That profile does not belong to your account.");
  }
  if (!profile.enabled) return fail(400, "That connection profile is disabled.");

  const { error: upsertError } = await supabaseAdmin
    .from("device_profile_assignments")
    .upsert(
      { device_id: deviceId, profile_id: profileId, assigned_at: new Date().toISOString() },
      { onConflict: "device_id" }
    );
  if (upsertError) {
    // Defense in depth: the trigger's rejection is reported as the same 403
    // the pre-check returns for the identical condition.
    if (upsertError.message.includes("device_profile_account_mismatch")) {
      return fail(403, "That profile does not belong to your account.");
    }
    throw new Error(`device_profile_assignments upsert failed: ${upsertError.message}`);
  }

  // The checks above and the upsert are not one transaction, so a revoke or
  // a profile-disable landing in between would leave an assignment that
  // should never have existed. Re-read both and undo if either changed.
  const [{ data: deviceAfter, error: deviceAfterError }, { data: profileAfter, error: profileAfterError }] =
    await Promise.all([
      supabaseAdmin.from("devices").select("status").eq("id", deviceId).maybeSingle(),
      supabaseAdmin.from("connection_profiles").select("enabled").eq("id", profileId).maybeSingle(),
    ]);
  if (deviceAfterError) throw new Error(`devices re-check failed: ${deviceAfterError.message}`);
  if (profileAfterError) throw new Error(`connection_profiles re-check failed: ${profileAfterError.message}`);

  if (deviceAfter?.status === "REVOKED" || !profileAfter?.enabled) {
    const { error: revertError } = await supabaseAdmin
      .from("device_profile_assignments")
      .delete()
      .eq("device_id", deviceId)
      .eq("profile_id", profileId);
    if (revertError) console.error(`assignDeviceProfile: revert failed: ${revertError.message}`);
    return fail(409, "The device or profile changed while assigning — reload and retry.");
  }

  // A new profile can mean a new route: re-place the device now so its
  // identity moves (make-before-break) or, fail-closed, stops serving a
  // route the new profile does not allow.
  let placement = null;
  const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
  if (entitlement) {
    const result = await reconcileDeviceProvisioning(supabaseAdmin, env, {
      device: { ...device, status: deviceAfter.status },
      entitlement,
      idempotencyPrefix: `device-profile:${deviceId}:${profileId}:${Date.now()}`,
    });
    placement = result.placement?.ok
      ? { status: "PLACED" }
      : result.placement
        ? { status: "UNSCHEDULABLE", error: result.placement.reason }
        : null;
  }

  return { status: 200, body: { ok: true, deviceId, profileId, placement } };
}
