/**
 * Account lookups. Billing hangs off customer_accounts, but VPN credentials
 * stay per-user: every member gets their own VLESS UUID / Hysteria2
 * password. So almost every request has to walk
 * user -> account_members -> customer_accounts before it can answer a
 * question about entitlement, and almost every Stripe event has to walk the
 * other way, from an account out to each member's VPN account.
 *
 * Both directions live here so the join is written once.
 */

/** Seats included in the base price before any per-seat item is billed. */
export const INCLUDED_SEATS = 3;

/**
 * Extra seats are sold in packs, not one at a time — a pack is the same
 * size as the included base allotment, so total capacity is always
 * `INCLUDED_SEATS * (1 + pack_quantity)`. `subscriptions.extra_seats`
 * remains the source-of-truth mirror of Stripe's seat-item quantity, in
 * seats (not packs); this constant only converts between the two at the
 * edges — the purchase API's request/response shape and pack-quantity-
 * shaped error messages.
 */
export const SEAT_PACK_SIZE = INCLUDED_SEATS;

/**
 * How many whole extra packs `extraSeats` represents. Rounds up so a
 * non-pack-aligned `extra_seats` value (only reachable via a manual Stripe
 * dashboard edit — our own purchase API only ever writes multiples of
 * SEAT_PACK_SIZE) is never under-reported: the caller always sees at least
 * as many packs as the seats actually in place.
 */
export function packQuantityFromExtraSeats(extraSeats) {
  return Math.ceil(Math.max(0, extraSeats) / SEAT_PACK_SIZE);
}

/**
 * The account a user belongs to. account_members.user_id is unique, so this
 * is at most one row and maybeSingle() cannot throw on a multi-row result.
 *
 * Returns null only when the user has no membership at all, which the
 * handle_new_user trigger makes impossible for any account created after
 * the customer_accounts migration — treat it as a hard error at call sites,
 * not an expected state.
 *
 * @returns {Promise<{ accountId: string, role: string } | null>}
 */
export async function getAccountForUser(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from("account_members")
    .select("account_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`account_members lookup failed: ${error.message}`);
  if (!data) return null;
  return { accountId: data.account_id, role: data.role };
}

/**
 * Every user id on an account. Ordered owner-first so callers that need a
 * single representative member (first provisioning, billing contact) get the
 * owner without a second query.
 *
 * @returns {Promise<Array<{ userId: string, role: string }>>}
 */
export async function getAccountMembers(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("account_members")
    .select("user_id, role")
    .eq("account_id", accountId);
  if (error) throw new Error(`account_members lookup failed: ${error.message}`);
  const rows = (data ?? []).map((r) => ({ userId: r.user_id, role: r.role }));
  // Owner first. Sorting on the role text would put 'member' first, so order
  // on the predicate instead.
  rows.sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
  return rows;
}

/**
 * The provisioned VPN accounts for every member of an account on one node.
 *
 * A Stripe cancellation has to disable all of them, and a renewal has to
 * extend all of them — before the account model there was exactly one VPN
 * account per subscription and both were a single job. Callers fan out over
 * this list and must key their provisioning_jobs idempotency on the
 * individual vpn_account, not on the subscription alone.
 *
 * Members with no vpn_accounts row yet are simply absent: either their
 * CREATE_USER job has not been processed or they were never provisioned.
 * Distinguishing those two is the caller's job, since only it knows whether
 * a missing row is a retryable race.
 *
 * @returns {Promise<Array<{ id: number, vpnUserId: string, userId: string }>>}
 */
export async function getMemberVpnAccounts(supabaseAdmin, accountId, nodeId) {
  const members = await getAccountMembers(supabaseAdmin, accountId);
  if (members.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, vpn_user_id, user_id, enabled")
    .in(
      "user_id",
      members.map((m) => m.userId)
    )
    .eq("node_id", nodeId);
  if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id,
    vpnUserId: r.vpn_user_id,
    userId: r.user_id,
    enabled: r.enabled,
  }));
}

/**
 * The account's live subscription, or null. The partial unique index
 * subscriptions_account_active_uniq guarantees at most one row in these
 * three statuses, so maybeSingle() is safe here where querying account_id
 * alone would not be — a lapsed-then-resubscribed account keeps its old
 * canceled rows forever.
 *
 * past_due and trialing count as live on purpose: a customer in Stripe's
 * dunning window, or on the free trial, still has service.
 */
export async function getLiveSubscription(supabaseAdmin, accountId, columns = "*") {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(columns)
    .eq("account_id", accountId)
    .in("status", ["trialing", "active", "past_due"])
    .maybeSingle();
  if (error) throw new Error(`subscriptions lookup failed: ${error.message}`);
  return data ?? null;
}


/**
 * Returns all currently-valid support grants for an account. Historical
 * expired/revoked rows remain queryable for audit but never confer access.
 */
export async function getActiveAdminEntitlements(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("admin_entitlements")
    .select("id, starts_at, expires_at, seat_limit, reason, created_at")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`admin_entitlements lookup failed: ${error.message}`);

  const now = Date.now();
  return (data ?? []).filter((row) => {
    const starts = new Date(row.starts_at).getTime();
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
    return Number.isFinite(starts) && starts <= now && expires > now;
  });
}

/** Backward-compatible convenience for callers that only need one row. */
export async function getActiveAdminEntitlement(supabaseAdmin, accountId) {
  const grants = await getActiveAdminEntitlements(supabaseAdmin, accountId);
  return grants[0] ?? null;
}

function laterIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * Pure entitlement composition. Callers may obtain the live Stripe row and
 * valid support grants through ordinary PostgREST queries or through the
 * one-round-trip dashboard RPC; the business rule lives only here.
 */
export function resolveEffectiveEntitlement(subscription, grants = []) {
  if (!subscription && grants.length === 0) return null;

  const stripeSeatLimit = subscription
    ? INCLUDED_SEATS + (subscription.extra_seats ?? 0)
    : 0;
  const grantSeatLimit = grants.reduce(
    (max, grant) => Math.max(max, grant.seat_limit ?? 0),
    0
  );
  const seatLimit = Math.max(INCLUDED_SEATS, stripeSeatLimit, grantSeatLimit);

  const clearExpiry = grants.some((grant) => grant.expires_at === null);
  let serviceExpiresAt = subscription?.current_period_end ?? null;
  if (!clearExpiry) {
    for (const grant of grants) {
      serviceExpiresAt = laterIso(serviceExpiresAt, grant.expires_at ?? null);
    }
  } else {
    serviceExpiresAt = null;
  }

  const newestGrant = grants[0] ?? null;

  if (subscription) {
    return {
      source: "stripe",
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end ?? null,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      seatLimit,
      extraSeats: Math.max(0, seatLimit - INCLUDED_SEATS),
      serviceExpiresAt,
      clearExpiry,
      subscription,
      grant: newestGrant,
      grants,
    };
  }

  return {
    source: "admin_grant",
    status: "active",
    currentPeriodEnd: serviceExpiresAt,
    cancelAtPeriodEnd: false,
    seatLimit,
    extraSeats: Math.max(0, seatLimit - INCLUDED_SEATS),
    serviceExpiresAt,
    clearExpiry,
    subscription: null,
    grant: newestGrant,
    grants,
  };
}

/**
 * Effective service entitlement for mutation/event code using normal table
 * queries. Read-heavy dashboard paths use the same pure resolver with the
 * batched snapshot RPC.
 */
export async function getEffectiveEntitlement(supabaseAdmin, accountId) {
  const [subscription, grants] = await Promise.all([
    getLiveSubscription(
      supabaseAdmin,
      accountId,
      "id, status, current_period_end, cancel_at_period_end, extra_seats"
    ),
    getActiveAdminEntitlements(supabaseAdmin, accountId),
  ]);

  return resolveEffectiveEntitlement(subscription, grants);
}
