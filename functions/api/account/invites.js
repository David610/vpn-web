import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import {
  getAccountForUser,
  getLiveSubscription,
  INCLUDED_SEATS,
} from "../../lib/accounts.js";
import { generateInviteToken, hashInviteToken } from "../../lib/invite-token.js";
import { sendMemberInvite } from "../../lib/resend.js";

const INVITE_TTL_DAYS = 7;

/**
 * Invites an email onto the caller's account.
 *
 * Owner-only: a member cannot hand out seats on a plan they do not pay for.
 * Requires a live subscription, since an invite to an unbilled account
 * promises service that does not exist.
 *
 * The seat check here is for the inviter's benefit, not a security boundary
 * — accept_member_invite re-checks under a row lock, which is what actually
 * prevents over-committing a plan when two invites are accepted at once.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    // Deliberately permissive: the address only has to be deliverable, and
    // the invite is worthless to anyone who cannot read that inbox.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return jsonResponse({ error: "Enter a valid email address." }, 400);
    }

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`invites: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }
    if (account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can invite members." }, 403);
    }

    const subscription = await getLiveSubscription(
      supabaseAdmin,
      account.accountId,
      "extra_seats"
    );
    if (!subscription) {
      return jsonResponse(
        { error: "You need an active subscription before inviting members." },
        403
      );
    }

    const nowIso = new Date().toISOString();
    const [{ count: memberCount, error: memberError }, { data: liveInvites, error: inviteListError }] =
      await Promise.all([
        supabaseAdmin
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.accountId),
        supabaseAdmin
          .from("member_invites")
          .select("id, email")
          .eq("account_id", account.accountId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", nowIso),
      ]);
    if (memberError) throw new Error(`account_members count failed: ${memberError.message}`);
    if (inviteListError) throw new Error(`member_invites query failed: ${inviteListError.message}`);

    const alreadyInvited = liveInvites.find((i) => i.email.toLowerCase() === email);
    const seatLimit = INCLUDED_SEATS + (subscription.extra_seats ?? 0);
    // Re-inviting an address replaces its outstanding invite rather than
    // consuming a second seat, so it does not count toward the total here.
    const seatsUsed = memberCount + liveInvites.length - (alreadyInvited ? 1 : 0);
    if (seatsUsed >= seatLimit) {
      return jsonResponse(
        {
          error: `All ${seatLimit} seats are in use. Remove a member or add a seat first.`,
          code: "seats_full",
        },
        409
      );
    }

    // member_invites_pending_uniq allows only one live invite per address
    // per account, so a resend must retire the previous one first. Revoking
    // rather than updating keeps the old token permanently spent.
    if (alreadyInvited) {
      const { error: revokeError } = await supabaseAdmin
        .from("member_invites")
        .update({ revoked_at: nowIso })
        .eq("id", alreadyInvited.id);
      if (revokeError) throw new Error(`member_invites revoke failed: ${revokeError.message}`);
    }

    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();

    const { data: invite, error: insertError } = await supabaseAdmin
      .from("member_invites")
      .insert({
        account_id: account.accountId,
        email,
        token_hash: tokenHash,
        invited_by: user.id,
        expires_at: expiresAt,
      })
      .select("id, email, expires_at, created_at")
      .single();
    if (insertError) throw new Error(`member_invites insert failed: ${insertError.message}`);

    // Best-effort, like every other send in this app. sendMemberInvite
    // swallows its own failures, but the row is already committed by this
    // point, so guard here too: a 500 after a successful write would tell
    // the owner nothing happened when in fact the seat is now reserved.
    try {
      await sendMemberInvite(env, {
        to: email,
        inviterEmail: user.email,
        acceptUrl: `${env.SITE_URL}/invite/?token=${encodeURIComponent(token)}`,
        expiresAt,
      });
    } catch (sendErr) {
      console.error("invites: invite email failed to send:", sendErr.message);
    }

    // The token is never returned to the browser: it belongs only in the
    // invitee's inbox, so possession of the link is what proves the invitee
    // controls that address.
    return jsonResponse(
      {
        invite: {
          id: invite.id,
          email: invite.email,
          expiresAt: invite.expires_at,
          createdAt: invite.created_at,
        },
      },
      201
    );
  } catch (err) {
    console.error("invites: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
