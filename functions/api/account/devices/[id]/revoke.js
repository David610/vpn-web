import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../../../lib/user-auth.js";
import { getAccountForUser } from "../../../../lib/accounts.js";

/**
 * Revokes a device the caller owns (via their account). Sets
 * status = 'REVOKED'; devices are never deleted, since the row is the
 * record that this device's access was cut off and when.
 *
 * vpn_accounts.device_id is not yet dual-read/written by any app code path
 * (per the Phase 1 migration's own comment, still true as of this phase),
 * so there is no credential to disable and no provisioning job to enqueue
 * here — revoking a device is purely a devices-table state change today.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  const deviceId = params.id;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account/devices/:id/revoke: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: device, error: lookupError } = await supabaseAdmin
      .from("devices")
      .select("id, account_id, status")
      .eq("id", deviceId)
      .maybeSingle();
    if (lookupError) throw new Error(`devices lookup failed: ${lookupError.message}`);
    // Same response for "does not exist" and "belongs to another account" —
    // the id alone must not confirm which one it is.
    if (!device || device.account_id !== account.accountId) {
      return jsonResponse({ error: "Device not found" }, 404);
    }

    if (device.status === "REVOKED") {
      return jsonResponse({ error: "This device has already been revoked." }, 409);
    }

    // Guard the write on the status this request just read, mirroring
    // admin/nodes/:id/lifecycle.js: without it, two concurrent revoke
    // requests both pass the check above and the second UPDATE is a no-op
    // that silently reports success for a write that never happened.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("devices")
      .update({ status: "REVOKED" })
      .eq("id", deviceId)
      .eq("status", device.status)
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error(`devices update failed: ${updateError.message}`);
    if (!updated) {
      return jsonResponse(
        { error: "Device status changed concurrently — reload and retry" },
        409
      );
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("account/devices/:id/revoke: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
