import { getAccountForUser } from "../../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { publicClient, publicLink, validLinkUpdate } from "../../../../lib/vpn-links.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "link GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Link not found" } };
    const { data: link, error } = await db.from("vpn_links")
      .select("id,name,configuration_family,desired_route_id,max_clients,status,location_mode,created_at,revoked_at")
      .eq("id", context.params.id).eq("account_id", account.accountId).maybeSingle();
    if (error) throw new Error(`link lookup failed: ${error.message}`);
    if (!link) return { status: 404, body: { error: "Link not found" } };
    const { data: clients, error: clientError } = await db.from("external_vpn_devices")
      .select("device_id,link_id,client_type,desired_route_id,last_subscription_fetch_at,revoked_at,created_at,devices(name)")
      .eq("link_id", link.id).eq("account_id", account.accountId).order("created_at", { ascending: true });
    if (clientError) throw new Error(`link client lookup failed: ${clientError.message}`);
    const { data: route, error: routeError } = await db.from("logical_routes").select("display_name,region,privacy_class")
      .eq("id", link.desired_route_id).maybeSingle();
    if (routeError) throw new Error(`route label lookup failed: ${routeError.message}`);
    const active = (clients ?? []).filter((c) => !c.revoked_at);
    return { status: 200, body: { link: publicLink(link, active.length, route?.display_name ?? route?.region, active[0]?.device_id ?? null, route?.privacy_class ?? null),
      clients: (clients ?? []).map(publicClient) } };
  }, { recent: false });
}

export async function onRequestPatch(context) {
  return runAccountAction(context, "link PATCH", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const input = validLinkUpdate(parsed.body);
    if (!input) return { status: 400, body: { error: "Invalid Link update" } };
    const account = await getAccountForUser(db, user.id);
    const { data, error } = await db.rpc("update_vpn_link", { p_link_id: context.params.id,
      p_account_id: account?.accountId, p_name: input.name, p_max_clients: input.maxClients });
    if (error) {
      if (/link_capacity_below_active_clients/.test(error.message ?? "")) return { status: 409, body: { error: "Capacity is below active client count" } };
      throw new Error(`link update failed: ${error.message}`);
    }
    return data ? { status: 200, body: { updated: true } } : { status: 404, body: { error: "Link not found" } };
  });
}

export async function onRequestDelete(context) {
  return runAccountAction(context, "link DELETE", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const { data, error } = await db.rpc("revoke_vpn_link", { p_link_id: context.params.id, p_account_id: account?.accountId });
    if (error) throw new Error(`link revocation failed: ${error.message}`);
    return data ? { status: 200, body: { revoked: true } } : { status: 404, body: { error: "Link not found" } };
  });
}
