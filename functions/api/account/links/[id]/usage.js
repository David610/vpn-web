import { getAccountForUser } from "../../../../lib/accounts.js";
import { runAccountAction } from "../../../../lib/account-http.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "link usage GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const { data: link, error: linkError } = await db.from("vpn_links").select("id")
      .eq("id", context.params.id).eq("account_id", account?.accountId).maybeSingle();
    if (linkError) throw new Error(`link lookup failed: ${linkError.message}`);
    if (!link) return { status: 404, body: { error: "Link not found" } };
    const { data, error } = await db.from("vpn_link_usage_daily")
      .select("device_id,bucket_date,rx_bytes,tx_bytes,connection_count,last_seen_bucket")
      .eq("account_id", account.accountId).eq("link_id", link.id).order("bucket_date", { ascending: false }).limit(90);
    if (error) throw new Error(`link usage lookup failed: ${error.message}`);
    return { status: 200, body: { usage: data ?? [], attribution: "client_daily_aggregate" } };
  }, { recent: false });
}
