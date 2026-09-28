/**
 * A faithful JS mirror of public.device_entitlement() (migrations
 * supabase/migrations/20261001000000_device_entitlement.sql and
 * 20261002000050_device_entitlement_assignment_order.sql), used by
 * fake-supabase.js so unit tests exercise the same capacity/suspension
 * rules the SQL RPC enforces in production, without a real Postgres.
 *
 * Any change to the SQL function's rules must be mirrored here, and the
 * property test in supabase/tests/device_entitlement_test.sql is the
 * authority for the real function's behaviour.
 *
 * Ranking uses subscription_assignment_seq, a sequence-backed ordinal, not
 * subscription_assigned_at (a timestamp) -- the latter can collide for two
 * rows inserted in the same transaction/statement, which was a real
 * non-determinism bug in the capacity gate (fixed by the second migration
 * above). Fixtures that don't set subscription_assignment_seq explicitly
 * fall back to insertion order via the array index, which is the closest
 * fake-supabase analogue of "assigned strictly increasing, never tied".
 */
const LIVE = new Set(["active", "trialing", "past_due"]);

function rankKey(d, index) {
  return d.subscription_assignment_seq ?? index;
}

function lessThan(a, b) {
  return a < b;
}

export function deviceEntitlementModel(args, tables) {
  const deviceId = args.p_device_id;
  const device = tables.devices.find((d) => d.id === deviceId);
  if (!device) return { data: [{ entitled: false, subscription_id: null, reason: "device_not_found" }], error: null };
  if (device.status !== "ACTIVE") {
    return { data: [{ entitled: false, subscription_id: null, reason: "device_revoked" }], error: null };
  }

  const account = tables.customer_accounts.find((a) => a.id === device.account_id);
  if (!account) return { data: [{ entitled: false, subscription_id: null, reason: "account_not_found" }], error: null };
  if (account.suspended_at) {
    return { data: [{ entitled: false, subscription_id: null, reason: "account_suspended" }], error: null };
  }
  if (account.deletion_requested_at) {
    return { data: [{ entitled: false, subscription_id: null, reason: "account_deletion_requested" }], error: null };
  }

  if (device.subscription_id != null) {
    const sub = tables.subscriptions.find((s) => s.id === device.subscription_id);
    if (sub && sub.account_id === device.account_id && LIVE.has(sub.status)) {
      const deviceIndex = tables.devices.indexOf(device);
      const rank = tables.devices.filter(
        (d2, i2) =>
          d2.subscription_id === sub.id &&
          d2.status === "ACTIVE" &&
          lessThan(rankKey(d2, i2), rankKey(device, deviceIndex))
      ).length;
      const capacity = 3 * (1 + Math.floor(Math.max(0, sub.extra_seats ?? 0) / 3));
      if (rank < capacity) {
        return { data: [{ entitled: true, subscription_id: sub.id, reason: "subscription" }], error: null };
      }
      return { data: [{ entitled: false, subscription_id: sub.id, reason: "over_capacity" }], error: null };
    }
  }

  const now = Date.now();
  const grant = tables.admin_entitlements
    .filter((g) => {
      if (g.account_id !== device.account_id || g.status !== "active") return false;
      const starts = new Date(g.starts_at).getTime();
      const expires = g.expires_at ? new Date(g.expires_at).getTime() : Infinity;
      return starts <= now && expires > now;
    })
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];

  if (!grant) return { data: [{ entitled: false, subscription_id: null, reason: "no_subscription" }], error: null };

  const deviceIndex2 = tables.devices.indexOf(device);
  const rank = tables.devices.filter((d3, i3) => {
    if (d3.account_id !== device.account_id || d3.status !== "ACTIVE") return false;
    const s3 = d3.subscription_id != null ? tables.subscriptions.find((s) => s.id === d3.subscription_id) : null;
    const s3Live = s3 && LIVE.has(s3.status);
    return !s3Live && lessThan(rankKey(d3, i3), rankKey(device, deviceIndex2));
  }).length;

  if (rank < (grant.seat_limit ?? 0)) {
    return { data: [{ entitled: true, subscription_id: null, reason: "admin_grant" }], error: null };
  }
  return { data: [{ entitled: false, subscription_id: null, reason: "over_capacity" }], error: null };
}
