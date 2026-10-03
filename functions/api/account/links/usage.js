import { getAccountForUser } from "../../../lib/accounts.js";
import { runAccountAction } from "../../../lib/account-http.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "account link usage GET", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const { data, error } = await db.from("vpn_link_usage_daily")
      .select("link_id,device_id,bucket_date,rx_bytes,tx_bytes,connection_count,last_seen_bucket")
      .eq("account_id", account.accountId).order("bucket_date", { ascending: false }).limit(500);
    if (error) throw new Error(`account link usage lookup failed: ${error.message}`);
    return { status: 200, body: { usage: data ?? [], attribution: "client_daily_aggregate" } };
  }, { recent: false });
}
