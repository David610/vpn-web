import { getAccountForUser } from "./accounts.js";
import { supportsMode } from "./client-capabilities.js";
import { COMPATIBILITY_LIFETIME_MS, newOpaqueId, newProtocolCredential, newSubscriptionToken, subscriptionTokenHash, subscriptionUrl } from "./external-credentials.js";
import { CLIENT_NAME, idempotencyHash, LINK_NAME } from "./vpn-links.js";

export const GENERIC_LINK_CLIENT = "links";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const failure = (status, code, error) => ({ status, body: { error, code } });

export function parseCreateLink(body, style = "v1") {
  const name = String(body?.name ?? "").trim();
  const routeId = body?.[style === "v1" ? "route_id" : "routeId"];
  const maxClients = body?.[style === "v1" ? "max_clients" : "maxClients"];
  if (!LINK_NAME.test(name) || !/^route_[a-z0-9_]{3,60}$/.test(routeId ?? "") ||
      !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 100) return null;
  return { name, routeId, maxClients };
}

export function parseCreateClient(body) {
  const name = String(body?.name ?? "").trim();
  const subscriptionId = body?.subscription_id ?? body?.subscriptionId;
  if (!CLIENT_NAME.test(name) || !/^[0-9]{1,18}$/.test(String(subscriptionId ?? ""))) return null;
  return { name, subscriptionId: Number(subscriptionId) };
}

async function accountIdFor(db, user) {
  return (await getAccountForUser(db, user.id))?.accountId ?? null;
}

async function routesById(db, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await db.from("logical_routes").select("id,display_name,region,privacy_class,enabled").in("id", [...new Set(ids)]);
  if (error) throw new Error(`route lookup failed: ${error.message}`);
  return new Map((data ?? []).map((route) => [route.id, route]));
}

export function linkView(row, activeClients, route) {
  return { id: row.id, name: row.name, status: row.status, route_id: row.desired_route_id,
    route_label: route?.display_name ?? route?.region ?? row.desired_route_id,
    configuration_family: row.configuration_family, active_clients: activeClients,
    max_clients: row.max_clients, created_at: row.created_at, revoked_at: row.revoked_at };
}

export function clientView(row) {
  return { id: row.device_id, name: row.devices?.name ?? row.name, status: row.revoked_at ? "revoked" : "active",
    client_type: row.client_type, created_at: row.created_at, last_seen_at: row.last_subscription_fetch_at ?? null,
    revoked_at: row.revoked_at ?? null };
}

export async function listLinks(db, user) {
  const accountId = await accountIdFor(db, user);
  if (!accountId) return failure(404, "link_not_found", "Link not found");
  const { data, error } = await db.from("vpn_links").select("id,name,configuration_family,desired_route_id,max_clients,status,created_at,revoked_at")
    .eq("account_id", accountId).order("created_at", { ascending: true });
  if (error) throw new Error(`link lookup failed: ${error.message}`);
  const { data: clients, error: clientError } = await db.from("external_vpn_devices").select("link_id,revoked_at").eq("account_id", accountId);
  if (clientError) throw new Error(`link client count failed: ${clientError.message}`);
  const routes = await routesById(db, (data ?? []).map((row) => row.desired_route_id));
  return { status: 200, body: { links: (data ?? []).map((row) => linkView(row,
    (clients ?? []).filter((client) => client.link_id === row.id && !client.revoked_at).length, routes.get(row.desired_route_id))) } };
}

export async function createLink(db, user, input) {
  const accountId = await accountIdFor(db, user);
  if (!accountId) return failure(404, "link_not_found", "Link not found");
  const { data: route, error: routeError } = await db.from("logical_routes").select("id,display_name,region,privacy_class,enabled").eq("id", input.routeId).maybeSingle();
  if (routeError) throw new Error(`route lookup failed: ${routeError.message}`);
  if (!route?.enabled) return failure(422, "unsupported_route", "Route is unavailable for Links");
  if (!supportsMode(GENERIC_LINK_CLIENT, route.privacy_class)) return failure(422, "unsupported_route", "Route is unsupported for compatible Link clients");
  const { data: id, error } = await db.rpc("create_vpn_link", { p_account_id: accountId, p_name: input.name,
    p_route_id: input.routeId, p_max_clients: input.maxClients });
  if (error) {
    if (/route_unavailable/.test(error.message ?? "")) return failure(422, "unsupported_route", "Route is unavailable for Links");
    throw new Error(`link creation failed: ${error.message}`);
  }
  const { data: created, error: createdError } = await db.from("vpn_links")
    .select("id,name,configuration_family,desired_route_id,max_clients,status,created_at,revoked_at")
    .eq("id", id).eq("account_id", accountId).maybeSingle();
  if (createdError || !created) throw new Error(`created Link lookup failed: ${createdError?.message ?? "missing row"}`);
  return { status: 201, body: { link: linkView(created, 0, route) } };
}

export async function getLink(db, user, linkId) {
  const accountId = await accountIdFor(db, user);
  const { data: link, error } = await db.from("vpn_links").select("id,name,configuration_family,desired_route_id,max_clients,status,created_at,revoked_at")
    .eq("id", linkId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`link lookup failed: ${error.message}`);
  if (!link) return failure(404, "link_not_found", "Link not found");
  const { data: clients, error: clientError } = await db.from("external_vpn_devices")
    .select("device_id,link_id,client_type,last_subscription_fetch_at,revoked_at,created_at,devices(name)")
    .eq("link_id", link.id).eq("account_id", accountId).order("created_at", { ascending: true });
  if (clientError) throw new Error(`link client lookup failed: ${clientError.message}`);
  const routes = await routesById(db, [link.desired_route_id]);
  return { status: 200, body: { link: linkView(link, (clients ?? []).filter((c) => !c.revoked_at).length, routes.get(link.desired_route_id)),
    clients: (clients ?? []).map(clientView) } };
}

export async function createClient(db, env, request, user, linkId, input) {
  const accountId = await accountIdFor(db, user);
  const idemHash = await idempotencyHash(request, env);
  if (!idemHash) return failure(400, "invalid_idempotency_key", "A valid Idempotency-Key is required");
  const { data: link, error: linkError } = await db.from("vpn_links").select("id,desired_route_id,status").eq("id", linkId).eq("account_id", accountId).maybeSingle();
  if (linkError) throw new Error(`link lookup failed: ${linkError.message}`);
  if (!link || link.status !== "active") return failure(404, "link_not_found", "Link not found");
  const { data: route, error: routeError } = await db.from("logical_routes").select("id,privacy_class,enabled").eq("id", link.desired_route_id).maybeSingle();
  if (routeError) throw new Error(`route lookup failed: ${routeError.message}`);
  if (!route?.enabled || !supportsMode(GENERIC_LINK_CLIENT, route.privacy_class)) return failure(422, "unsupported_route", "Route is unsupported for compatible Link clients");
  const token = newSubscriptionToken();
  const generatedHash = await subscriptionTokenHash(token, env);
  const protocol = await newProtocolCredential(env);
  const { data: deviceId, error } = await db.rpc("create_vpn_link_client", { p_link_id: link.id, p_account_id: accountId,
    p_user_id: user.id, p_subscription_id: input.subscriptionId, p_name: input.name, p_client_type: GENERIC_LINK_CLIENT,
    p_idempotency_key: idemHash, p_principal_id: newOpaqueId("ext"), p_token_hash: generatedHash,
    p_credential_id: newOpaqueId("cred"), p_credential_ciphertext: protocol.ciphertext, p_credential_nonce: protocol.nonce,
    p_valid_until: new Date(Date.now() + COMPATIBILITY_LIFETIME_MS).toISOString() });
  if (error) {
    if (/subscription_not_entitled/.test(error.message ?? "")) return failure(404, "subscription_not_found", "Subscription not found");
    if (/seats_full|link_capacity_full/.test(error.message ?? "")) return failure(409, "capacity_exhausted", "No client capacity is available");
    if (/idempotency/.test(error.message ?? "")) return failure(409, "idempotency_conflict", "Idempotency-Key was already used for another request");
    if (/link_not_active/.test(error.message ?? "")) return failure(404, "link_not_found", "Link not found");
    throw new Error(`link client creation failed: ${error.message}`);
  }
  const { data: created } = await db.from("external_vpn_devices")
    .select("device_id,client_type,created_at,last_subscription_fetch_at,revoked_at,subscription_token_hash,devices(name)")
    .eq("device_id", deviceId).eq("account_id", accountId).eq("link_id", link.id).maybeSingle();
  const replayed = created?.subscription_token_hash !== generatedHash;
  const client = clientView(created ?? { device_id: deviceId, name: input.name, client_type: GENERIC_LINK_CLIENT, created_at: new Date().toISOString() });
  return replayed ? { status: 200, body: { client, replayed: true } } : { status: 201,
    body: { client, replayed: false, configuration_url: subscriptionUrl(request, token, GENERIC_LINK_CLIENT), shown_once: true } };
}

async function ownedClient(db, accountId, linkId, clientId) {
  const { data, error } = await db.from("external_vpn_devices").select("device_id,link_id,client_type,created_at,last_subscription_fetch_at,revoked_at,devices(name)")
    .eq("device_id", clientId).eq("account_id", accountId).eq("link_id", linkId).maybeSingle();
  if (error) throw new Error(`link client lookup failed: ${error.message}`);
  return data;
}

export async function replaceAccessLink(db, env, request, user, linkId, clientId) {
  const accountId = await accountIdFor(db, user);
  const client = await ownedClient(db, accountId, linkId, clientId);
  if (!client || client.revoked_at) return failure(404, "client_not_found", "Client not found");
  const token = newSubscriptionToken();
  const { data, error } = await db.from("external_vpn_devices").update({ subscription_token_hash: await subscriptionTokenHash(token, env), updated_at: new Date().toISOString() })
    .eq("device_id", clientId).eq("account_id", accountId).eq("link_id", linkId).is("revoked_at", null).select("device_id").maybeSingle();
  if (error) throw new Error(`token rotation failed: ${error.message}`);
  if (!data) return failure(404, "client_not_found", "Client not found");
  return { status: 200, body: { client: clientView(client), configuration_url: subscriptionUrl(request, token, client.client_type), shown_once: true } };
}

export async function revokeClient(db, user, linkId, clientId) {
  const accountId = await accountIdFor(db, user);
  if (!await ownedClient(db, accountId, linkId, clientId)) return failure(404, "client_not_found", "Client not found");
  const { data, error } = await db.rpc("revoke_external_vpn_device", { p_device_id: clientId, p_account_id: accountId });
  if (error) throw new Error(`client revocation failed: ${error.message}`);
  return data ? { status: 204, body: null } : failure(404, "client_not_found", "Client not found");
}

export async function revokeLink(db, user, linkId) {
  const accountId = await accountIdFor(db, user);
  const { data, error } = await db.rpc("revoke_vpn_link", { p_link_id: linkId, p_account_id: accountId });
  if (error) throw new Error(`link revocation failed: ${error.message}`);
  return data ? { status: 204, body: null } : failure(404, "link_not_found", "Link not found");
}

export async function compatibleLinkRoutes(db) {
  const { data, error } = await db.from("logical_routes").select("id,region,privacy_class,display_name").eq("enabled", true).order("display_name");
  if (error) throw new Error(`logical route lookup failed: ${error.message}`);
  return (data ?? []).filter((route) => supportsMode(GENERIC_LINK_CLIENT, route.privacy_class));
}
