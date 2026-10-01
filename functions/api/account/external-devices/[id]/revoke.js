import { getAccountForUser } from "../../../../lib/accounts.js";
import { runAccountAction } from "../../../../lib/account-http.js";

export async function onRequestPost(context) {
  return runAccountAction(context, "external-device revoke", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const { data, error } = await db.rpc("revoke_external_vpn_device", {
      p_device_id: context.params.id, p_account_id: account?.accountId,
    });
    if (error) throw new Error(`external device revocation failed: ${error.message}`);
    return data ? { status: 200, body: { revoked: true } } : { status: 404, body: { error: "External device not found" } };
  });
}
