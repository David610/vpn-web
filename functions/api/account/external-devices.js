import { getAccountForUser } from "../../lib/accounts.js";
import { readJson, runAccountAction } from "../../lib/account-http.js";
import { COMPATIBILITY_LIFETIME_MS, mintCompatibilityCredentials, newOpaqueId, newSubscriptionToken, subscriptionTokenHash, subscriptionUrl } from "../../lib/external-credentials.js";
import { isSupportedClient, supportsMode } from "../../lib/client-capabilities.js";
import { clientCapabilities } from "../../lib/client-capabilities.js";
import { compatibleLinkRoutes } from "../../lib/links-service.js";

const NAME = /^[\p{L}\p{N} ._'()-]{1,40}$/u;

export async function onRequestGet(context) {
  return runAccountAction(context, "external-devices GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const { data, error } = await db.from("external_vpn_devices")
      .select("device_id,client_type,principal_id,desired_route_id,last_subscription_fetch_at,revoked_at,created_at")
      .eq("account_id", account.accountId).order("created_at", { ascending: true });
    if (error) throw new Error(`external device lookup failed: ${error.message}`);
    const { data: routes, error: routeError } = await db.from("logical_routes")
      .select("id,region,privacy_class,display_name").eq("enabled", true).order("display_name");
    if (routeError) throw new Error(`logical route lookup failed: ${routeError.message}`);
    const linkRoutes = await compatibleLinkRoutes(db);
    return { status: 200, body: { devices: data ?? [], routes: routes ?? [], link_routes: linkRoutes, capabilities: clientCapabilities() } };
  }, { recent: false });
}

export async function onRequestPost(context) {
  return runAccountAction(context, "external-devices POST", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const { name, clientType, routeId, subscriptionId } = parsed.body;
    if (!NAME.test(String(name ?? "").trim()) || !isSupportedClient(clientType) ||
        !/^route_[a-z0-9_]{3,60}$/.test(routeId ?? "") || !/^[0-9]{1,18}$/.test(String(subscriptionId ?? ""))) {
      return { status: 400, body: { error: "Invalid external device request" } };
    }
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const { data: route, error: routeError } = await db.from("logical_routes")
      .select("id,privacy_class,enabled").eq("id", routeId).maybeSingle();
    if (routeError) throw new Error(`route lookup failed: ${routeError.message}`);
    if (!route?.enabled) return { status: 404, body: { error: "Logical route not found" } };
    if (!supportsMode(clientType, route.privacy_class)) {
      return { status: 422, body: { error: `${clientType} does not support Arcana Privacy+`, code: "unsupported_client_mode" } };
    }

    const token = newSubscriptionToken();
    const principalId = newOpaqueId("ext");
    const tokenHash = await subscriptionTokenHash(token, context.env);
    const credentials = await mintCompatibilityCredentials(context.env, route.privacy_class);
    const validUntil = new Date(Date.now() + COMPATIBILITY_LIFETIME_MS).toISOString();
    const { data: deviceId, error } = await db.rpc("create_external_vpn_device", {
      p_account_id: account.accountId, p_user_id: user.id, p_subscription_id: Number(subscriptionId),
      p_name: String(name).trim(), p_client_type: clientType, p_principal_id: principalId,
      p_token_hash: tokenHash, p_route_id: routeId, p_credentials: credentials,
      p_valid_until: validUntil,
    });
    if (error) {
      if (/seats_full|subscription_not_entitled/.test(error.message ?? "")) {
        return { status: 409, body: { error: "This subscription has no available device seat." } };
      }
      throw new Error(`external device creation failed: ${error.message}`);
    }
    return { status: 201, body: { deviceId, subscriptionUrl: subscriptionUrl(context.request, token, clientType), shownOnce: true } };
  });
}
