/**
 * Read model for the Telegram Mini App. Built on the website's shared
 * getOverview() so both surfaces show the same subscriptions, capacity and
 * devices, plus the account's connection profiles and each device's
 * assignment (the Mini App shows all of it on one screen).
 *
 * The Mini App is a link manager: it lists, creates, copies, edits and revokes
 * the account's VPN links. An access link is a bearer credential, so it is only
 * returned by the dedicated access-link/create/replace routes, which require
 * initData signed within the last hour.
 *
 * Deliberately omits anything the Mini App does not need: the account email
 * and billing identifiers.
 */
import { getOverview } from "./account-service.js";
import { getAccountForUser } from "./accounts.js";
import { routingAxes } from "./connection-profiles.js";
import { browserListLinks, compatibleLinkRoutes, createLinkWithClient, moveLinkToRoute } from "./links-service.js";
import { CLIENT_NAME } from "./vpn-links.js";

function profileView(p) {
  return {
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    routingMode: p.routing_mode,
    ...routingAxes(p.routing_mode),
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

// ── Links ────────────────────────────────────────────────────────────────────

const LIVE_STATUSES = new Set(["trialing", "active", "past_due", "cancelling"]);
const LOCATION_MODES = new Set(["auto", "manual"]);
const ROUTE_ID = /^route_[a-z0-9_]{3,60}$/;

function planSummary(overview) {
  const sub = overview.subscriptions.find((s) => LIVE_STATUSES.has(s.status)) ?? null;
  if (!sub) return null;
  return {
    status: sub.status,
    priceCents: overview.plan.basePriceCents + overview.plan.packPriceCents * sub.extraPacks,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    used: sub.used,
    capacity: sub.capacity,
  };
}

/** The first live subscription with a free device place, or null. */
function subscriptionWithRoom(overview) {
  return overview.subscriptions.find((s) => LIVE_STATUSES.has(s.status) && s.used < s.capacity) ?? null;
}

function parseLinkChoice(body, { withName }) {
  const locationMode = body?.locationMode ?? "manual";
  const routeId = body?.routeId;
  if (!LOCATION_MODES.has(locationMode)) return null;
  if (locationMode === "manual" && !ROUTE_ID.test(routeId ?? "")) return null;
  if (!withName) return { locationMode, routeId };
  const name = String(body?.name ?? "").trim();
  if (!CLIENT_NAME.test(name)) return null;
  return { name, locationMode, routeId };
}

const NO_ROOM = {
  status: 409,
  body: { error: "You have no free device place. Revoke a link you no longer use, or check your plan.", code: "capacity_exhausted" },
};

/** Every active link, the locations that can be chosen, and the plan card. */
export async function getMiniAppLinks(db, user) {
  const listed = await browserListLinks(db, user);
  if (listed.status !== 200) return listed;
  const [routes, overview] = await Promise.all([compatibleLinkRoutes(db), getOverview(db, user)]);
  if (overview.status !== 200) return overview;
  return {
    status: 200,
    body: {
      links: listed.body.links.filter((l) => l.status === "active"),
      routes: routes.map((r) => ({ id: r.id, displayName: r.display_name, region: r.region, privacyClass: r.privacy_class })),
      plan: planSummary(overview.body),
    },
  };
}

/** Body: { name, locationMode: "auto"|"manual", routeId? }. The new access link is returned once; copy it again via access-link. */
export async function createMiniAppLink(db, env, request, user, body) {
  const input = parseLinkChoice(body, { withName: true });
  if (!input) return { status: 400, body: { error: "Invalid link request" } };
  const overview = await getOverview(db, user);
  if (overview.status !== 200) return overview;
  const subscription = subscriptionWithRoom(overview.body);
  if (!subscription) return NO_ROOM;
  const result = await createLinkWithClient(db, env, request, user, { ...input, subscriptionId: Number(subscription.id) });
  return result.status === 201 ? { status: 201, body: { id: result.body.id, configurationUrl: result.body.configuration_url } } : result;
}

/** Body: { locationMode, routeId? }. Creates the replacement first, then revokes the old link. */
export async function moveMiniAppLink(db, env, request, user, linkId, body) {
  const input = parseLinkChoice(body, { withName: false });
  if (!input) return { status: 400, body: { error: "Invalid link request" } };
  const overview = await getOverview(db, user);
  if (overview.status !== 200) return overview;
  const subscription = subscriptionWithRoom(overview.body);
  if (!subscription) return NO_ROOM;
  const result = await moveLinkToRoute(db, env, request, user, linkId, { ...input, subscriptionId: Number(subscription.id) });
  return result.status === 201
    ? { status: 201, body: { id: result.body.id, configurationUrl: result.body.configuration_url, oldRevoked: result.body.old_revoked } }
    : result;
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
