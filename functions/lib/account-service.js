/**
 * Account actions shared by the website (/api/account/*) and the Arcana app
 * (/v1/*). Every function takes an authenticated user and returns
 * { status, body } with a user-safe message, so the two HTTP surfaces only
 * differ in authentication and field naming.
 *
 * Billing model (see supabase/migrations/20260926000000_subscription_devices.sql):
 * one person per account, any number of subscriptions, and each
 * subscription covers 3 devices plus 3 per paid pack.
 */
import Stripe from "stripe";
import { getAccountForUser, getEffectiveEntitlement } from "./accounts.js";
import { syncAccountProvisioningToEntitlement } from "./provision-entitlement.js";
import { revokeDevice } from "./device-provisioning.js";
import {
  getAccountSubscription,
  isLive,
  listAccountSubscriptions,
  pickSubscriptionWithRoom,
  subscriptionView,
} from "./subscriptions.js";
import { deviceCapacity, DEVICE_PACK_SIZE, INCLUDED_DEVICES } from "./seat-constants.js";
import { getSeatPackQuantity, getSeatSubscriptionItem } from "./stripe-fields.js";
import { passwordGrant, AuthRejected } from "./gotrue.js";

export const MAX_EXTRA_PACKS = 17;
const NAME = /^[^\u0000-\u001f]{1,80}$/u;
const DEVICE_NAME = /^[^\u0000-\u001f]{1,80}$/u;
const PLATFORMS = new Set(["ios", "android", "macos", "windows", "linux", "router", "other"]);

const ok = (body = { ok: true }, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function stripeClient(env) {
  return new Stripe(env.STRIPE_API_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

async function accountOf(supabaseAdmin, user) {
  const account = await getAccountForUser(supabaseAdmin, user.id);
  if (!account) throw new Error(`user ${user.id} has no account_members row`);
  return account;
}

async function listDevices(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select(
      "id, account_id, user_id, name, platform, status, created_at, last_seen_at, subscription_id, placement_status, placement_error, auth_session_id"
    )
    .eq("account_id", accountId);
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  return (data ?? []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function reconcile(supabaseAdmin, env, accountId, prefix) {
  const entitlement = await getEffectiveEntitlement(supabaseAdmin, accountId);
  return syncAccountProvisioningToEntitlement(supabaseAdmin, accountId, entitlement, prefix, env);
}

function deviceView(device, { sessionId = null } = {}) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform ?? "",
    status: device.status,
    subscriptionId: device.subscription_id == null ? null : String(device.subscription_id),
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at ?? null,
    current: !!sessionId && device.auth_session_id === sessionId,
    placement: device.placement_status
      ? { status: device.placement_status, error: device.placement_error ?? null }
      : null,
  };
}

/** Everything the account pages and the app's Account tab show. */
export async function getOverview(supabaseAdmin, user, { sessionId = null } = {}) {
  const account = await accountOf(supabaseAdmin, user);
  const [subscriptions, devices, accountRow] = await Promise.all([
    listAccountSubscriptions(supabaseAdmin, account.accountId),
    listDevices(supabaseAdmin, account.accountId),
    supabaseAdmin
      .from("customer_accounts")
      .select("trial_used_at, stripe_customer_id")
      .eq("id", account.accountId)
      .maybeSingle(),
  ]);
  if (accountRow.error) throw new Error(`customer_accounts lookup failed: ${accountRow.error.message}`);
  const active = devices.filter((d) => d.status !== "REVOKED");
  const views = subscriptions
    .filter((s) => isLive(s) || s.status === "canceled" || s.status === "unpaid")
    .map((s) => subscriptionView(s, active));
  const live = views.filter((v) => isLive({ status: v.stripeStatus }));
  return ok({
    email: user.email,
    role: account.role,
    // The one-time trial is for an account that never had a subscription.
    trialAvailable: !accountRow.data?.trial_used_at && subscriptions.length === 0,
    billingAccount: Boolean(accountRow.data?.stripe_customer_id),
    subscriptions: views,
    devices: active.map((d) => deviceView(d, { sessionId })),
    capacity: {
      total: live.reduce((sum, v) => sum + v.capacity, 0),
      used: active.filter((d) => live.some((v) => v.id === String(d.subscription_id))).length,
    },
    plan: {
      includedDevices: INCLUDED_DEVICES,
      devicesPerPack: DEVICE_PACK_SIZE,
      basePriceCents: 699,
      packPriceCents: 699,
      currency: "EUR",
      maxExtraPacks: MAX_EXTRA_PACKS,
    },
  });
}

async function subscriptionOrFail(supabaseAdmin, account, subscriptionId) {
  if (!/^[0-9]{1,18}$/.test(String(subscriptionId))) return null;
  return getAccountSubscription(supabaseAdmin, account.accountId, Number(subscriptionId));
}

export async function renameSubscription(supabaseAdmin, user, subscriptionId, name) {
  const account = await accountOf(supabaseAdmin, user);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!NAME.test(trimmed)) return fail(400, "Use 1–80 characters.");
  const sub = await subscriptionOrFail(supabaseAdmin, account, subscriptionId);
  if (!sub) return fail(404, "Subscription not found.");
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  if (error) throw new Error(`subscriptions rename failed: ${error.message}`);
  return ok();
}

/**
 * Sets the absolute number of extra 3-device packs. Never drops capacity
 * below the devices already on the subscription: the customer moves or
 * removes a device first, so nobody is cut off by a billing change.
 */
export async function setExtraPacks(supabaseAdmin, env, user, subscriptionId, packs) {
  if (!Number.isInteger(packs) || packs < 0 || packs > MAX_EXTRA_PACKS) {
    return fail(400, `Choose between 0 and ${MAX_EXTRA_PACKS} extra packs of ${DEVICE_PACK_SIZE} devices.`);
  }
  if (!env.STRIPE_SEAT_PRICE_ID) return fail(503, "Adding devices is not available yet.");
  const account = await accountOf(supabaseAdmin, user);
  const sub = await subscriptionOrFail(supabaseAdmin, account, subscriptionId);
  if (!sub) return fail(404, "Subscription not found.");
  if (!isLive(sub) || !sub.stripe_subscription_id) {
    return fail(409, "This subscription is not active.");
  }

  const devices = await listDevices(supabaseAdmin, account.accountId);
  const used = devices.filter(
    (d) => d.status !== "REVOKED" && String(d.subscription_id) === String(sub.id)
  ).length;
  const minimum = Math.ceil(Math.max(0, used - INCLUDED_DEVICES) / DEVICE_PACK_SIZE);
  if (packs < minimum) {
    return fail(
      409,
      `${used} devices use this subscription. Move or remove devices before going below ${deviceCapacity(minimum * DEVICE_PACK_SIZE)} devices.`,
      { code: "devices_in_use", minimum }
    );
  }

  const stripe = stripeClient(env);
  const current = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  const item = getSeatSubscriptionItem(current, env.STRIPE_SEAT_PRICE_ID);
  let updated = current;
  const prorate = { proration_behavior: "create_prorations" };
  if (packs === 0 && item) {
    updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: item.id, deleted: true }],
      ...prorate,
    });
  } else if (packs > 0 && item) {
    updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: item.id, quantity: packs }],
      ...prorate,
    });
  } else if (packs > 0) {
    updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ price: env.STRIPE_SEAT_PRICE_ID, quantity: packs }],
      ...prorate,
    });
  }

  const confirmed = getSeatPackQuantity(updated, env.STRIPE_SEAT_PRICE_ID);
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ extra_seats: confirmed * DEVICE_PACK_SIZE, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  if (error) console.error(`setExtraPacks: mirror failed: ${error.message}`);

  // More capacity may bring devices that were over the limit into service.
  await reconcile(supabaseAdmin, env, account.accountId, `packs:${sub.id}:${confirmed}:${Date.now()}`);
  return ok({ ok: true, extraPacks: confirmed, capacity: deviceCapacity(confirmed * DEVICE_PACK_SIZE) });
}

async function setCancelAtPeriodEnd(supabaseAdmin, env, user, subscriptionId, cancel) {
  const account = await accountOf(supabaseAdmin, user);
  const sub = await subscriptionOrFail(supabaseAdmin, account, subscriptionId);
  if (!sub) return fail(404, "Subscription not found.");
  if (!isLive(sub) || !sub.stripe_subscription_id) return fail(409, "This subscription is not active.");
  await stripeClient(env).subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: cancel,
  });
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ cancel_at_period_end: cancel, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  if (error) console.error(`cancel mirror failed: ${error.message}`);
  return ok();
}

export const cancelSubscription = (db, env, user, id) => setCancelAtPeriodEnd(db, env, user, id, true);
export const resumeSubscription = (db, env, user, id) => setCancelAtPeriodEnd(db, env, user, id, false);

async function deviceOrFail(supabaseAdmin, account, deviceId) {
  if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) return null;
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, user_id, status, subscription_id, auth_session_id")
    .eq("id", deviceId)
    .maybeSingle();
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  if (!data || data.account_id !== account.accountId || data.status === "REVOKED") return null;
  return data;
}

export async function renameDevice(supabaseAdmin, user, deviceId, name) {
  const account = await accountOf(supabaseAdmin, user);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!DEVICE_NAME.test(trimmed)) return fail(400, "Use 1–80 characters.");
  const device = await deviceOrFail(supabaseAdmin, account, deviceId);
  if (!device) return fail(404, "Device not found.");
  const { error } = await supabaseAdmin.from("devices").update({ name: trimmed }).eq("id", device.id);
  if (error) throw new Error(`devices rename failed: ${error.message}`);
  return ok();
}

/** Moves a device to another subscription that has a free place. */
export async function moveDevice(supabaseAdmin, env, user, deviceId, subscriptionId) {
  const account = await accountOf(supabaseAdmin, user);
  const device = await deviceOrFail(supabaseAdmin, account, deviceId);
  if (!device) return fail(404, "Device not found.");
  const target = await subscriptionOrFail(supabaseAdmin, account, subscriptionId);
  if (!target || !isLive(target)) return fail(404, "Subscription not found.");
  if (String(device.subscription_id) === String(target.id)) return ok();
  const devices = await listDevices(supabaseAdmin, account.accountId);
  const used = devices.filter(
    (d) => d.status !== "REVOKED" && String(d.subscription_id) === String(target.id)
  ).length;
  if (used >= deviceCapacity(target.extra_seats)) {
    return fail(409, `"${target.name}" is full. Add 3 devices to it first.`);
  }
  const { error } = await supabaseAdmin
    .from("devices")
    .update({ subscription_id: target.id })
    .eq("id", device.id);
  if (error) throw new Error(`devices move failed: ${error.message}`);
  await reconcile(supabaseAdmin, env, account.accountId, `device-moved:${device.id}:${target.id}:${Date.now()}`);
  return ok();
}

export async function removeDevice(supabaseAdmin, env, user, deviceId) {
  const account = await accountOf(supabaseAdmin, user);
  const device = await deviceOrFail(supabaseAdmin, account, deviceId);
  if (!device) return fail(404, "Device not found.");
  const { revoked } = await revokeDevice(supabaseAdmin, env, device, `device-revoked:${device.id}`);
  if (!revoked) return fail(409, "The device changed at the same time. Try again.");
  // A freed place may bring an over-capacity device into service.
  await reconcile(supabaseAdmin, env, account.accountId, `device-freed:${device.id}`);
  return ok();
}

/**
 * The devices row for an app session, created on first sign-in. Joins the
 * oldest subscription with a free place; without one it is recorded but not
 * served until the customer adds capacity or moves it.
 */
export async function ensureSessionDevice(supabaseAdmin, env, user, sessionId, { name, platform } = {}) {
  if (!sessionId) throw new Error("session has no session_id claim");
  const account = await accountOf(supabaseAdmin, user);
  const { data: existing, error } = await supabaseAdmin
    .from("devices")
    .select("id, status, subscription_id")
    .eq("auth_session_id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  if (existing) return existing;

  const [subscriptions, devices] = await Promise.all([
    listAccountSubscriptions(supabaseAdmin, account.accountId),
    listDevices(supabaseAdmin, account.accountId),
  ]);
  const room = pickSubscriptionWithRoom(subscriptions, devices);
  const cleanName = typeof name === "string" && DEVICE_NAME.test(name.trim()) ? name.trim() : "New device";
  const { data: created, error: insertError } = await supabaseAdmin
    .from("devices")
    .insert({
      account_id: account.accountId,
      user_id: user.id,
      name: cleanName,
      platform: PLATFORMS.has(platform) ? platform : null,
      status: "ACTIVE",
      subscription_id: room?.id ?? null,
      auth_session_id: sessionId,
    })
    .select("id, status, subscription_id")
    .single();
  if (insertError) {
    // A concurrent first request for the same session created it.
    if (insertError.code === "23505") return ensureSessionDevice(supabaseAdmin, env, user, sessionId);
    throw new Error(`devices insert failed: ${insertError.message}`);
  }
  await reconcile(supabaseAdmin, env, account.accountId, `device-signed-in:${created.id}`);
  return created;
}

export async function renameSessionDevice(supabaseAdmin, env, user, sessionId, name) {
  const device = await ensureSessionDevice(supabaseAdmin, env, user, sessionId);
  return renameDevice(supabaseAdmin, user, device.id, name);
}

/** Logging out an app session frees its device place. */
export async function releaseSessionDevice(supabaseAdmin, env, user, sessionId) {
  if (!sessionId) return;
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, user_id, status, subscription_id")
    .eq("auth_session_id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  if (!data || data.status === "REVOKED") return;
  await revokeDevice(supabaseAdmin, env, data, `device-signed-out:${data.id}`);
}

/**
 * Requests permanent deletion. Requires the password again. Bans sign-in,
 * cancels every subscription immediately, revokes every device; the auth
 * user (and everything cascading from it) is removed by
 * finalizeAccountDeletions() once no VPN identity remains enabled.
 */
export async function requestAccountDeletion(supabaseAdmin, env, user, password) {
  if (typeof password !== "string" || password.length === 0 || password.length > 4096) {
    return fail(400, "Enter your password to confirm.");
  }
  try {
    await passwordGrant(env, user.email, password);
  } catch (err) {
    if (err instanceof AuthRejected) return fail(403, "That password is not correct.");
    throw err;
  }
  const account = await accountOf(supabaseAdmin, user);
  if (account.role !== "owner") {
    return fail(403, "Only the account owner can delete this account.");
  }

  const { error: markError } = await supabaseAdmin
    .from("customer_accounts")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", account.accountId);
  if (markError) throw new Error(`customer_accounts mark failed: ${markError.message}`);

  const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    ban_duration: "876000h",
  });
  if (banError) throw new Error(`auth ban failed: ${banError.message}`);

  const subscriptions = await listAccountSubscriptions(supabaseAdmin, account.accountId);
  const stripe = stripeClient(env);
  for (const sub of subscriptions.filter((s) => isLive(s) && s.stripe_subscription_id)) {
    await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    await supabaseAdmin
      .from("subscriptions")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("id", sub.id);
  }

  const devices = await listDevices(supabaseAdmin, account.accountId);
  for (const device of devices.filter((d) => d.status !== "REVOKED")) {
    await revokeDevice(supabaseAdmin, env, device, `account-deleted:${device.id}`);
  }
  return ok({ ok: true, deletion: "scheduled" }, 202);
}

/**
 * Completes deletions whose VPN identities are all disabled and whose jobs
 * have finished. Called from the fleet tick.
 */
export async function finalizeAccountDeletions(supabaseAdmin, { limit = 10 } = {}) {
  const { data: pending, error } = await supabaseAdmin
    .from("customer_accounts")
    .select("id")
    .not("deletion_requested_at", "is", null)
    .limit(limit);
  if (error) throw new Error(`deletion lookup failed: ${error.message}`);
  const finished = [];
  for (const row of pending ?? []) {
    const { data: members, error: memberError } = await supabaseAdmin
      .from("account_members")
      .select("user_id")
      .eq("account_id", row.id);
    if (memberError) throw new Error(`account_members lookup failed: ${memberError.message}`);
    const userIds = (members ?? []).map((m) => m.user_id);
    if (userIds.length > 0) {
      const { data: live, error: liveError } = await supabaseAdmin
        .from("vpn_accounts")
        .select("id")
        .in("user_id", userIds)
        .eq("enabled", true)
        .limit(1);
      if (liveError) throw new Error(`vpn_accounts lookup failed: ${liveError.message}`);
      if ((live ?? []).length > 0) continue;
      const { data: jobs, error: jobError } = await supabaseAdmin
        .from("provisioning_jobs")
        .select("id, vpn_accounts!inner(user_id)")
        .in("vpn_accounts.user_id", userIds)
        .in("status", ["pending", "claimed"])
        .limit(1);
      if (jobError) throw new Error(`provisioning_jobs lookup failed: ${jobError.message}`);
      if ((jobs ?? []).length > 0) continue;
    }
    for (const userId of userIds) {
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteError) throw new Error(`auth delete failed: ${deleteError.message}`);
    }
    const { error: accountDeleteError } = await supabaseAdmin
      .from("customer_accounts")
      .delete()
      .eq("id", row.id);
    if (accountDeleteError) throw new Error(`customer_accounts delete failed: ${accountDeleteError.message}`);
    finished.push(row.id);
  }
  return finished;
}
