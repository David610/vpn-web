import { INCLUDED_SEATS } from "./accounts.js";

/**
 * Builds the account/member snapshot used by both /api/account and the
 * dashboard config response. Keeping it here prevents two APIs from drifting
 * on seat math, invite filtering, or profile lookup behavior.
 */
export async function buildAccountOverview(
  supabaseAdmin,
  user,
  account,
  entitlement
) {
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

  const memberIds = (memberRows ?? []).map((m) => m.user_id);
  const { data: profileRows, error: profilesError } = memberIds.length
    ? await supabaseAdmin
        .from("profiles")
        .select("id, email")
        .in("id", memberIds)
    : { data: [], error: null };
  if (profilesError) throw new Error(`profiles query failed: ${profilesError.message}`);

  const emailByUserId = new Map((profileRows ?? []).map((p) => [p.id, p.email]));
  const seatLimit = entitlement?.seatLimit ?? INCLUDED_SEATS;
  const seatsUsed = (memberRows?.length ?? 0) + (inviteRows?.length ?? 0);

  return {
    accountId: account.accountId,
    role: account.role,
    subscription: entitlement
      ? {
          source: entitlement.source,
          status: entitlement.status,
          currentPeriodEnd: entitlement.currentPeriodEnd,
          cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        }
      : null,
    seats: {
      included: INCLUDED_SEATS,
      extra: entitlement?.extraSeats ?? 0,
      limit: seatLimit,
      used: seatsUsed,
      available: Math.max(0, seatLimit - seatsUsed),
    },
    members: (memberRows ?? [])
      .map((m) => ({
        userId: m.user_id,
        email: emailByUserId.get(m.user_id) ?? null,
        role: m.role,
        joinedAt: m.created_at,
        isYou: m.user_id === user.id,
      }))
      .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner")),
    invites: (inviteRows ?? []).map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    })),
  };
}
