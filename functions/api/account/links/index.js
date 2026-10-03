import { getAccountForUser } from "../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../lib/account-http.js";
import { publicLink, validLinkInput } from "../../../lib/vpn-links.js";

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
    return { status: 200, body: { links: (data ?? []).map((link) => publicLink(link,
      (clients ?? []).filter((client) => client.link_id === link.id && !client.revoked_at).length)) } };
  }, { recent: false });
}

export async function onRequestPost(context) {
  return runAccountAction(context, "links POST", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const input = validLinkInput(parsed.body);
    if (!input) return { status: 400, body: { error: "Invalid Link request" } };
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const { data, error } = await db.rpc("create_vpn_link", {
      p_account_id: account.accountId, p_name: input.name,
      p_route_id: input.routeId, p_max_clients: input.maxClients,
    });
    if (error) {
      if (/route_unavailable/.test(error.message ?? "")) return { status: 422, body: { error: "Route is unavailable" } };
      throw new Error(`link creation failed: ${error.message}`);
    }
    return { status: 201, body: { id: data } };
  });
}
