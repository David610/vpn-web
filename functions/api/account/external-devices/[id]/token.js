import { getAccountForUser } from "../../../../lib/accounts.js";
import { runAccountAction } from "../../../../lib/account-http.js";
import { newSubscriptionToken, subscriptionTokenHash, subscriptionUrl } from "../../../../lib/external-credentials.js";

export async function onRequestPost(context) {
  return runAccountAction(context, "external-device token rotation", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const token = newSubscriptionToken();
    const hash = await subscriptionTokenHash(token, context.env);
    const { data, error } = await db.from("external_vpn_devices")
      .update({ subscription_token_hash: hash, updated_at: new Date().toISOString() })
      .eq("device_id", context.params.id).eq("account_id", account?.accountId).is("revoked_at", null)
      .select("device_id,client_type").maybeSingle();
    if (error) throw new Error(`token rotation failed: ${error.message}`);
    if (!data) return { status: 404, body: { error: "External device not found" } };
    return { status: 200, body: { subscriptionUrl: subscriptionUrl(context.request, token, data.client_type), shownOnce: true } };
  });
}
