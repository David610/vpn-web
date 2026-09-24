import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../../lib/user-auth.js";
import { getAccountForUser } from "../../../lib/accounts.js";
import { revokeDevice } from "../../../lib/device-provisioning.js";

/**
 * Removes a member from the caller's account, or lets a member remove
 * themselves (leaving the plan). Owners cannot be removed by anyone — an
 * account with no owner has nobody to bill.
 *
 * The removed user keeps their Supabase login and gets a fresh empty account
 * of their own, so "every user has exactly one account" still holds. Their
 * VPN access is revoked, since it was granted by the plan they just left.
 */
export async function onRequestDelete({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const targetUserId = params.id;
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`members/[id]: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const isSelf = targetUserId === user.id;
    if (!isSelf && account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can remove members." }, 403);
    }

    // Resolve the member's devices before the membership goes away --
    // afterwards nothing links this user to the plan being revoked.
    const { data: memberDevices, error: devicesError } = await supabaseAdmin
      .from("devices")
      .select("id, account_id, user_id, status")
      .eq("account_id", account.accountId)
      .eq("user_id", targetUserId);
    if (devicesError) throw new Error(`devices lookup failed: ${devicesError.message}`);

    const { error: rpcError } = await supabaseAdmin.rpc("remove_account_member", {
      p_account_id: account.accountId,
      p_user_id: targetUserId,
    });
    if (rpcError) {
      if (rpcError.message.includes("not_a_member")) {
        return jsonResponse({ error: "That person is not on this plan." }, 404);
      }
      if (rpcError.message.includes("cannot_remove_owner")) {
        return jsonResponse(
          { error: "The account owner cannot be removed. Cancel the subscription instead." },
          409
        );
      }
      throw new Error(`remove_account_member failed: ${rpcError.message}`);
    }

    // Every device the member had on this plan loses access, on every node
    // its identities live on -- not just the legacy node-1 identity.
    for (const device of memberDevices ?? []) {
      try {
        await revokeDevice(
          supabaseAdmin,
          env,
          device,
          `member-removed:${account.accountId}:${targetUserId}`
        );
      } catch (err) {
        // The membership is already gone, so this cannot be rolled back.
        // Log loudly: the seat is free but a credential may still be live
        // until an admin re-runs the revocation.
        console.error(`members/[id]: revoking device ${device.id} failed: ${err.message}`);
      }
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("members/[id]: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
