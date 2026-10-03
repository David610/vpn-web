import { getAccountForUser } from "../../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { publicClient } from "../../../../lib/vpn-links.js";
import { createClient, parseCreateClient } from "../../../../lib/links-service.js";

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
    const input = parseCreateClient(parsed.body);
    if (!input || parsed.body.clientType !== "links") {
      return { status: 400, body: { error: "Invalid client request or Idempotency-Key" } };
    }
    const result = await createClient(db, context.env, context.request, user, context.params.id, input);
    if (result.status >= 400) return result;
    return result.body.replayed ? { status: 200, body: { deviceId: result.body.client.id, replayed: true } } : { status: 201,
      body: { deviceId: result.body.client.id, configurationUrl: result.body.configuration_url, shownOnce: true } };
  });
}
