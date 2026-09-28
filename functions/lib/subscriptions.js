/**
 * Subscriptions and their devices.
 *
 * An account is one person. It may hold several subscriptions; each covers
 * deviceCapacity(extra_seats) devices, and every device belongs to at most
 * one subscription.
 *
 * Whether a given device is entitled right now is NOT decided here: that
 * question (device within its subscription's capacity, oldest devices
 * first, or covered by an admin_entitlements support grant) is answered
 * exclusively by public.device_entitlement() -- see
 * functions/lib/device-entitlement.js's checkDeviceEntitlement /
 * resolveDeviceEntitlement, the only callers should use. This module keeps
 * only account-level helpers (listing subscriptions, picking one with room
 * for a device that doesn't exist yet, and the plain display math in
 * subscriptionView) that are not themselves entitlement decisions.
 */
import { deviceCapacity } from "./seat-constants.js";
import { isPastDueWithinGrace } from "./stripe-fields.js";

export const LIVE_STATUSES = ["trialing", "active", "past_due"];

/**
 * F-40: `past_due` only counts as live within its bounded grace window
 * (isPastDueWithinGrace / env.PAST_DUE_GRACE_MS) — a subscription that has
 * stayed past_due beyond that window is no longer treated as live, even
 * though its Stripe status string hasn't changed yet (see stripe-fields.js
 * for the rationale and the default). `env`/`now` are optional so every
 * existing call site (`isLive(sub)`) keeps working unchanged, using the
 * default grace window and the real clock; callers that have a real `env`
 * object should pass it through so env.PAST_DUE_GRACE_MS is honored.
 *
 * @param {object|null} subscription - a subscriptions row (must include
 *   `status`, and `past_due_since` if the row can be past_due)
 * @param {object} env
 * @param {number} now - unix ms, injectable for tests
 */
export function isLive(subscription, env = {}, now = Date.now()) {
  if (!subscription || !LIVE_STATUSES.includes(subscription.status)) return false;
  if (subscription.status === "past_due") {
    return isPastDueWithinGrace(subscription.past_due_since, env, now);
  }
  return true;
}

export async function listAccountSubscriptions(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, name, status, current_period_end, cancel_at_period_end, extra_seats, stripe_subscription_id, created_at, past_due_since"
    )
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`subscriptions lookup failed: ${error.message}`);
  return (data ?? []).sort(byCreatedAt);
}

export async function getAccountSubscription(supabaseAdmin, accountId, subscriptionId) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, name, status, current_period_end, cancel_at_period_end, extra_seats, stripe_subscription_id, created_at, past_due_since"
    )
    .eq("id", subscriptionId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions lookup failed: ${error.message}`);
  return data ?? null;
}

function byCreatedAt(a, b) {
  return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
}

/**
 * The live subscription a new device should join: the oldest one with a
 * free place, or null when every subscription is full.
 */
export function pickSubscriptionWithRoom(subscriptions, devices) {
  for (const sub of subscriptions.filter(isLive).sort(byCreatedAt)) {
    const used = devices.filter(
      (d) => d.status !== "REVOKED" && String(d.subscription_id) === String(sub.id)
    ).length;
    if (used < deviceCapacity(sub.extra_seats)) return sub;
  }
  return null;
}

export function subscriptionView(sub, devices = []) {
  const assigned = devices.filter(
    (d) => d.status !== "REVOKED" && String(d.subscription_id) === String(sub.id)
  );
  const capacity = deviceCapacity(sub.extra_seats);
  return {
    id: String(sub.id),
    name: sub.name ?? "Personal",
    status: sub.cancel_at_period_end && isLive(sub) ? "cancelling" : sub.status,
    stripeStatus: sub.status,
    extraPacks: Math.ceil(Math.max(0, sub.extra_seats ?? 0) / 3),
    capacity,
    used: assigned.length,
    currentPeriodEnd: sub.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
}
