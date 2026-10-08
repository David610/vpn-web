import { getAccountForUser } from "../../../../lib/accounts.js";
import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { validLinkUpdate } from "../../../../lib/vpn-links.js";
import { browserGetLink } from "../../../../lib/links-service.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "link GET", (db, user) => browserGetLink(db, user, context.params.id), { recent: false });
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
