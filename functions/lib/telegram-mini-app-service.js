/**
 * Read model for the Telegram Mini App. Built on the website's shared
 * getOverview() so both surfaces show the same subscriptions, capacity and
 * devices, plus the account's connection profiles and each device's
 * assignment (the Mini App shows all of it on one screen).
 *
 * Deliberately omits anything the Mini App does not need: the account email,
 * billing identifiers, and any subscription/setup URL (setup happens on the
 * website, never inside Telegram).
 */
import { getOverview } from "./account-service.js";
import { getAccountForUser } from "./accounts.js";

function profileView(p) {
  return {
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    routingMode: p.routing_mode,
    entryLocationId: p.preferred_entry_location_id ?? null,
    exitLocationId: p.preferred_exit_location_id ?? null,
  };
}

export async function listProfiles(db, accountId) {
  const { data, error } = await db
    .from("connection_profiles")
    .select("id, account_id, name, enabled, routing_mode, preferred_entry_location_id, preferred_exit_location_id")
    .eq("account_id", accountId)
    .order("name", { ascending: true });
  if (error) throw new Error(`connection_profiles lookup failed: ${error.message}`);
  return (data ?? []).filter((p) => p.account_id === accountId).map(profileView);
}

export async function getMiniAppProfiles(db, user) {
  const account = await getAccountForUser(db, user.id);
  if (!account) throw new Error(`user ${user.id} has no account_members row`);
  return { status: 200, body: { profiles: await listProfiles(db, account.accountId) } };
}

export async function getMiniAppOverview(db, user) {
  const account = await getAccountForUser(db, user.id);
  if (!account) throw new Error(`user ${user.id} has no account_members row`);
  const { status, body } = await getOverview(db, user);
  if (status !== 200) return { status, body };

  const profiles = await listProfiles(db, account.accountId);
  const deviceIds = body.devices.map((d) => d.id);
  let byDevice = new Map();
  if (deviceIds.length > 0) {
    const { data, error } = await db
      .from("device_profile_assignments")
      .select("device_id, profile_id")
      .in("device_id", deviceIds);
    if (error) throw new Error(`device_profile_assignments lookup failed: ${error.message}`);
    const own = new Set(profiles.map((p) => p.id));
    byDevice = new Map((data ?? []).filter((a) => own.has(a.profile_id)).map((a) => [a.device_id, a.profile_id]));
  }

  const { data: link, error: linkError } = await db
    .from("telegram_links")
    .select("telegram_username")
    .eq("user_id", user.id)
    .maybeSingle();
  if (linkError) throw new Error(`telegram_links lookup failed: ${linkError.message}`);

  return {
    status: 200,
    body: {
      role: body.role,
      telegramUsername: link?.telegram_username ?? null,
      subscriptions: body.subscriptions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        capacity: s.capacity,
        used: s.used,
        extraPacks: s.extraPacks,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      })),
      capacity: body.capacity,
      plan: { includedDevices: body.plan.includedDevices, devicesPerPack: body.plan.devicesPerPack },
      devices: body.devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        status: d.status,
        subscriptionId: d.subscriptionId,
        lastSeenAt: d.lastSeenAt,
        placement: d.placement,
        profileId: byDevice.get(d.id) ?? null,
      })),
      profiles,
    },
  };
}

/** Removes this Arcana user's Telegram link (the Mini App's "Unlink"). */
export async function unlinkTelegram(db, user) {
  const { data, error } = await db
    .from("telegram_links")
    .delete()
    .eq("user_id", user.id)
    .select("user_id")
    .maybeSingle();
  if (error) throw new Error(`telegram_links delete failed: ${error.message}`);
  if (!data) return { status: 404, body: { error: "No Telegram account is linked." } };
  return { status: 200, body: { ok: true } };
}
