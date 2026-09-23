import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import { getLiveSubscription } from "../../lib/accounts.js";
import { hashInviteToken } from "../../lib/invite-token.js";
import { resolveNodeForUser } from "../../lib/resolve-node.js";

/**
 * Every way accept_member_invite can refuse, mapped to what the invitee
 * should be told. The RPC raises these by name; anything unlisted is a bug
 * and becomes a 500 rather than a misleading message.
 */
const REFUSALS = {
  invite_not_found: [404, "This invitation link is not valid."],
  invite_already_accepted: [409, "This invitation has already been used."],
  invite_revoked: [409, "This invitation was withdrawn."],
  invite_expired: [410, "This invitation has expired. Ask for a new one."],
  seats_full: [409, "That plan has no seats left."],
  already_member: [409, "You are already on this plan."],
  has_own_subscription: [
    409,
    "You have your own active subscription. Cancel it before joining another plan.",
  ],
  owns_shared_account: [
    409,
    "You own a plan with other members. Remove them before joining another plan.",
  ],
};

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The invitee must be signed in: accepting binds the seat to a Supabase
  // user, and the token alone must not be enough to choose who that is.
  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return jsonResponse({ error: "This invitation link is not valid." }, 400);

    const tokenHash = await hashInviteToken(token);

    // The whole seat transition happens inside this call: validating the
    // invite, counting seats under a row lock, detaching the user from
    // their current account and attaching them to the new one. Splitting it
    // across PostgREST calls would let two people take the same last seat.
    const { data: accountId, error: rpcError } = await supabaseAdmin.rpc(
      "accept_member_invite",
      { p_token_hash: tokenHash, p_user_id: user.id }
    );

    if (rpcError) {
      const refusal = Object.entries(REFUSALS).find(([name]) =>
        rpcError.message.includes(name)
      );
      if (refusal) {
        const [status, message] = refusal[1];
        return jsonResponse({ error: message, code: refusal[0] }, status);
      }
      throw new Error(`accept_member_invite failed: ${rpcError.message}`);
    }

    // The seat is theirs regardless of what happens next; provisioning is a
    // separate concern and its own failure must not undo the membership.
    const subscription = await getLiveSubscription(
      supabaseAdmin,
      accountId,
      "current_period_end"
    );
    if (subscription?.current_period_end) {
      const nodeId = resolveNodeForUser();
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        // Keyed on the member, so a retried acceptance cannot enqueue a
        // second CREATE_USER for the same person.
        idempotency_key: `create-user:member:${accountId}:${user.id}`,
        node_id: nodeId,
        job_type: "CREATE_USER",
        vpn_account_id: null,
        payload: { user_id: user.id, expires_at: subscription.current_period_end },
      });
      if (jobError && jobError.code !== "23505") {
        // Logged, not fatal: the membership is committed, and an admin can
        // re-run provisioning. Failing here would leave the invite spent
        // with no way for the invitee to retry.
        console.error(`accept-invite: provisioning enqueue failed: ${jobError.message}`);
      }
    }

    return jsonResponse({ accountId, provisioning: Boolean(subscription) });
  } catch (err) {
    console.error("accept-invite: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
