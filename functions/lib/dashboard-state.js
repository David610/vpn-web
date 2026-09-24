import {
  INCLUDED_SEATS,
  SEAT_PACK_SIZE,
  packQuantityFromExtraSeats,
  resolveEffectiveEntitlement,
} from "./accounts.js";

export async function loadCustomerDashboardState(supabaseAdmin, user) {
  const { data, error } = await supabaseAdmin.rpc("customer_dashboard_state", {
    p_user_id: user.id,
  });
  if (error) {
    throw new Error(`customer_dashboard_state failed: ${error.message}`);
  }
  if (!data?.account) return null;

  const account = {
    accountId: data.account.account_id,
    role: data.account.role,
  };
  const grants = Array.isArray(data.grants) ? data.grants : [];
  const entitlement = resolveEffectiveEntitlement(data.subscription ?? null, grants);
  const members = Array.isArray(data.members) ? data.members : [];
  const invites = Array.isArray(data.invites) ? data.invites : [];
  const seatLimit = entitlement?.seatLimit ?? INCLUDED_SEATS;
  const seatsUsed = members.length + invites.length;

  const overview = {
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
      packSize: SEAT_PACK_SIZE,
      packQuantity: packQuantityFromExtraSeats(entitlement?.extraSeats ?? 0),
    },
    members: members
      .map((m) => ({
        userId: m.user_id,
        email: m.email ?? null,
        role: m.role,
        joinedAt: m.created_at,
        isYou: m.user_id === user.id,
      }))
      .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner")),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    })),
  };

  return {
    account,
    entitlement,
    overview,
    trial: {
      usedAt: data.account.trial_used_at ?? null,
      reservedAt: data.account.trial_reserved_at ?? null,
      checkoutSessionId: data.account.trial_checkout_session_id ?? null,
    },
    vpnAccount: data.vpn_account
      ? {
          id: data.vpn_account.id,
          enabled: data.vpn_account.enabled,
          vpnUserId: data.vpn_account.vpn_user_id ?? null,
          nodeId: data.vpn_account.node_id ?? null,
        }
      : null,
  };
}
