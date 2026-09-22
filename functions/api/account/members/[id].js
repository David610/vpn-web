import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../../lib/user-auth.js";
import { getAccountForUser } from "../../../lib/accounts.js";
import { resolveNodeForUser } from "../../../lib/resolve-node.js";

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

  const { user, response } = await requireUser(request, supabaseAdmin);
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

    // Resolve the VPN account before the membership goes away — afterwards
    // there is nothing linking this user to the plan being revoked.
    const nodeId = resolveNodeForUser();
    const { data: vpnAccount, error: vpnError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id")
      .eq("user_id", targetUserId)
      .eq("node_id", nodeId)
      .maybeSingle();
    if (vpnError) throw new Error(`vpn_accounts lookup failed: ${vpnError.message}`);

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

    if (vpnAccount) {
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        idempotency_key: `disable-user:member-removed:${account.accountId}:${targetUserId}`,
        node_id: nodeId,
        job_type: "DISABLE_USER",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpn_user_id, user_id: targetUserId },
      });
      if (jobError && jobError.code !== "23505") {
        // The membership is already gone, so this cannot be rolled back.
        // Log loudly: the seat is free but the credential is still live
        // until an admin re-runs the disable.
        console.error(`members/[id]: disable enqueue failed: ${jobError.message}`);
      }
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("members/[id]: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
