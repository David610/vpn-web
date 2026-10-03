import { getAccountForUser } from "../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../lib/account-http.js";
import { publicLink } from "../../../lib/vpn-links.js";
import { createLink, parseCreateLink } from "../../../lib/links-service.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "links GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const { data, error } = await db.from("vpn_links")
      .select("id,name,configuration_family,desired_route_id,max_clients,status,created_at,revoked_at")
      .eq("account_id", account.accountId).order("created_at", { ascending: true });
    if (error) throw new Error(`link lookup failed: ${error.message}`);
    const { data: clients, error: clientsError } = await db.from("external_vpn_devices")
      .select("link_id,revoked_at").eq("account_id", account.accountId);
    if (clientsError) throw new Error(`link client count failed: ${clientsError.message}`);
    const routeIds = [...new Set((data ?? []).map((link) => link.desired_route_id))];
    const { data: routes, error: routesError } = routeIds.length
      ? await db.from("logical_routes").select("id,display_name,region").in("id", routeIds)
      : { data: [], error: null };
    if (routesError) throw new Error(`route label lookup failed: ${routesError.message}`);
    const routeLabels = new Map((routes ?? []).map((route) => [route.id, route.display_name ?? route.region]));
    return { status: 200, body: { links: (data ?? []).map((link) => publicLink(link,
      (clients ?? []).filter((client) => client.link_id === link.id && !client.revoked_at).length,
      routeLabels.get(link.desired_route_id))) } };
  }, { recent: false });
}

export async function onRequestPost(context) {
  return runAccountAction(context, "links POST", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const input = parseCreateLink(parsed.body, "browser");
    if (!input) return { status: 400, body: { error: "Invalid Link request" } };
    const result = await createLink(db, user, input);
    return result.status === 201 ? { status: 201, body: { id: result.body.link.id } } : result;
  });
}
