import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import {
  getAccountForUser,
  getLiveSubscription,
  INCLUDED_SEATS,
} from "../../lib/accounts.js";

/**
 * The caller's account: who is on it, what invites are outstanding, and how
 * many seats remain.
 *
 * Every member can read this — seeing who shares your plan is not
 * privileged — but only the owner may act on it, which the mutating routes
 * enforce individually rather than trusting a flag returned from here.
 *
 * Invite rows deliberately expose no token: only its SHA-256 hash is stored
 * at all, and even that never leaves the server. A revoked or spent invite
 * is omitted entirely rather than listed as inert, so the client cannot
 * confuse it for something still usable.
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const subscription = await getLiveSubscription(
      supabaseAdmin,
      account.accountId,
      "status, current_period_end, cancel_at_period_end, extra_seats"
    );

    const [{ data: memberRows, error: membersError }, { data: inviteRows, error: invitesError }] =
      await Promise.all([
        supabaseAdmin
          .from("account_members")
          .select("user_id, role, created_at")
          .eq("account_id", account.accountId),
        supabaseAdmin
          .from("member_invites")
          .select("id, email, expires_at, created_at")
          .eq("account_id", account.accountId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString()),
      ]);
    if (membersError) throw new Error(`account_members query failed: ${membersError.message}`);
    if (invitesError) throw new Error(`member_invites query failed: ${invitesError.message}`);

    // Emails come from auth.users, which has no foreign-key join through
    // PostgREST, so resolve them in one admin call rather than per member.
    const { data: usersPage, error: usersError } = await supabaseAdmin.auth.admin.listUsers({
      perPage: 1000,
    });
    if (usersError) throw new Error(`listUsers failed: ${usersError.message}`);
    const emailByUserId = new Map(usersPage.users.map((u) => [u.id, u.email]));

    const seatLimit = INCLUDED_SEATS + (subscription?.extra_seats ?? 0);
    // A pending invite is a reserved seat. Counting only accepted members
    // would let an owner issue invites past the cap and discover the
    // shortfall only when someone tries to accept.
    const seatsUsed = memberRows.length + inviteRows.length;

    return jsonResponse({
      accountId: account.accountId,
      role: account.role,
      subscription: subscription
        ? {
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          }
        : null,
      seats: {
        included: INCLUDED_SEATS,
        extra: subscription?.extra_seats ?? 0,
        limit: seatLimit,
        used: seatsUsed,
        available: Math.max(0, seatLimit - seatsUsed),
      },
      members: memberRows
        .map((m) => ({
          userId: m.user_id,
          email: emailByUserId.get(m.user_id) ?? null,
          role: m.role,
          joinedAt: m.created_at,
          isYou: m.user_id === user.id,
        }))
        .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner")),
      invites: inviteRows.map((i) => ({
        id: i.id,
        email: i.email,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      })),
    });
  } catch (err) {
    console.error("account: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
