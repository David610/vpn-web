/**
 * Subscriptions and their devices.
 *
 * An account is one person. It may hold several subscriptions; each covers
 * deviceCapacity(extra_seats) devices, and every device belongs to at most
 * one subscription. Entitlement is therefore decided per device: the device
 * is served while its own subscription is live and the device is within
 * that subscription's capacity (oldest devices first). Support grants
 * (admin_entitlements) cover devices that have no live subscription.
 */
import { deviceCapacity, INCLUDED_DEVICES } from "./seat-constants.js";
import { getActiveAdminEntitlements, resolveEffectiveEntitlement } from "./accounts.js";

export const LIVE_STATUSES = ["trialing", "active", "past_due"];

export function isLive(subscription) {
  return !!subscription && LIVE_STATUSES.includes(subscription.status);
}

export async function listAccountSubscriptions(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, name, status, current_period_end, cancel_at_period_end, extra_seats, stripe_subscription_id, created_at"
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
      "id, name, status, current_period_end, cancel_at_period_end, extra_seats, stripe_subscription_id, created_at"
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
 * Pure: which devices are entitled, and to what.
 *
 * @param {Array} subscriptions  account subscriptions (any status)
 * @param {Array} grants         active admin grants (newest first)
 * @param {Array} devices        account devices
 * @returns {Map<string, object|null>} deviceId -> entitlement or null
 */
export function resolveDeviceEntitlements(subscriptions, grants, devices) {
  const result = new Map();
  const live = new Map(subscriptions.filter(isLive).map((s) => [String(s.id), s]));
  const active = devices.filter((d) => d.status !== "REVOKED").sort(byCreatedAt);
  const used = new Map();
  const unassigned = [];

  for (const device of devices) result.set(device.id, null);

  for (const device of active) {
    const sub = device.subscription_id != null ? live.get(String(device.subscription_id)) : null;
    if (!sub) {
      unassigned.push(device);
      continue;
    }
    const count = (used.get(sub.id) ?? 0) + 1;
    used.set(sub.id, count);
    if (count <= deviceCapacity(sub.extra_seats)) {
      result.set(device.id, resolveEffectiveEntitlement(sub, grants));
    }
  }

  // Support grants cover devices without a live subscription, up to the
  // grant's limit (seat_limit now counts devices).
  if (grants.length > 0) {
    const limit = Math.max(
      INCLUDED_DEVICES,
      ...grants.map((g) => g.seat_limit ?? 0)
    );
    const entitlement = resolveEffectiveEntitlement(null, grants);
    unassigned.slice(0, limit).forEach((d) => result.set(d.id, entitlement));
  }
  return result;
}

export async function loadDeviceEntitlements(supabaseAdmin, accountId, devices) {
  const [subscriptions, grants] = await Promise.all([
    listAccountSubscriptions(supabaseAdmin, accountId),
    getActiveAdminEntitlements(supabaseAdmin, accountId),
  ]);
  return resolveDeviceEntitlements(subscriptions, grants, devices);
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
