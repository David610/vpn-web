import { getAccountForUser } from "../../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { COMPATIBILITY_LIFETIME_MS, newOpaqueId, newProtocolCredential, newSubscriptionToken, subscriptionTokenHash, subscriptionUrl } from "../../../../lib/external-credentials.js";
import { isSupportedClient, supportsMode } from "../../../../lib/client-capabilities.js";
import { CLIENT_NAME, idempotencyHash, publicClient } from "../../../../lib/vpn-links.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "link clients GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const { data: link, error: linkError } = await db.from("vpn_links").select("id")
      .eq("id", context.params.id).eq("account_id", account?.accountId).maybeSingle();
    if (linkError) throw new Error(`link lookup failed: ${linkError.message}`);
    if (!link) return { status: 404, body: { error: "Link not found" } };
    const { data, error } = await db.from("external_vpn_devices")
      .select("device_id,link_id,client_type,desired_route_id,last_subscription_fetch_at,revoked_at,created_at,devices(name)")
      .eq("link_id", link.id).eq("account_id", account.accountId).order("created_at", { ascending: true });
    if (error) throw new Error(`link client lookup failed: ${error.message}`);
    return { status: 200, body: { clients: (data ?? []).map(publicClient) } };
  }, { recent: false });
}

export async function onRequestPost(context) {
  return runAccountAction(context, "link clients POST", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const { name, clientType, subscriptionId } = parsed.body;
    const idemHash = await idempotencyHash(context.request, context.env);
    if (!CLIENT_NAME.test(String(name ?? "").trim()) || !isSupportedClient(clientType) ||
        !/^[0-9]{1,18}$/.test(String(subscriptionId ?? "")) || !idemHash) {
      return { status: 400, body: { error: "Invalid client request or Idempotency-Key" } };
    }
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Link not found" } };
    const { data: link, error: linkError } = await db.from("vpn_links")
      .select("id,desired_route_id,status").eq("id", context.params.id)
      .eq("account_id", account.accountId).maybeSingle();
    if (linkError) throw new Error(`link lookup failed: ${linkError.message}`);
    if (!link || link.status !== "active") return { status: 404, body: { error: "Link not found" } };
    const { data: route, error: routeError } = await db.from("logical_routes")
      .select("id,privacy_class,enabled").eq("id", link.desired_route_id).maybeSingle();
    if (routeError) throw new Error(`route lookup failed: ${routeError.message}`);
    if (!route?.enabled) return { status: 422, body: { error: "Route is unavailable" } };
    if (!supportsMode(clientType, route.privacy_class)) return { status: 422,
      body: { error: `${clientType} does not support this Link route`, code: "unsupported_client_mode" } };

    const token = newSubscriptionToken();
    const protocol = await newProtocolCredential(context.env);
    const { data: deviceId, error } = await db.rpc("create_vpn_link_client", {
      p_link_id: link.id, p_account_id: account.accountId, p_user_id: user.id,
      p_subscription_id: Number(subscriptionId), p_name: String(name).trim(), p_client_type: clientType,
      p_idempotency_key: idemHash, p_principal_id: newOpaqueId("ext"),
      p_token_hash: await subscriptionTokenHash(token, context.env), p_credential_id: newOpaqueId("cred"),
      p_credential_ciphertext: protocol.ciphertext, p_credential_nonce: protocol.nonce,
      p_valid_until: new Date(Date.now() + COMPATIBILITY_LIFETIME_MS).toISOString(),
    });
    if (error) {
      if (/seats_full|subscription_not_entitled|link_capacity_full/.test(error.message ?? ""))
        return { status: 409, body: { error: "No client capacity is available" } };
      if (/link_not_active/.test(error.message ?? "")) return { status: 404, body: { error: "Link not found" } };
      throw new Error(`link client creation failed: ${error.message}`);
    }
    // An idempotent replay returns the original id, but must not disclose a
    // newly generated token that was never persisted for that client.
    const { data: created } = await db.from("external_vpn_devices").select("subscription_token_hash")
      .eq("device_id", deviceId).eq("account_id", account.accountId).maybeSingle();
    const generatedHash = await subscriptionTokenHash(token, context.env);
    const replayed = created?.subscription_token_hash !== generatedHash;
    return replayed ? { status: 200, body: { deviceId, replayed: true } } : { status: 201,
      body: { deviceId, configurationUrl: subscriptionUrl(context.request, token, clientType), shownOnce: true } };
  });
}
