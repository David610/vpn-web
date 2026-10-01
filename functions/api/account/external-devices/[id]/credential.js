import { getAccountForUser } from "../../../../lib/accounts.js";
import { runAccountAction } from "../../../../lib/account-http.js";
import { COMPATIBILITY_LIFETIME_MS, COMPATIBILITY_OVERLAP_MS, newOpaqueId, newProtocolCredential } from "../../../../lib/external-credentials.js";

export async function onRequestPost(context) {
  return runAccountAction(context, "external-device credential rotation", async (db, user) => {
    const account = await getAccountForUser(db, user.id);
    const credential = await newProtocolCredential(context.env);
    const credentialId = newOpaqueId("cred");
    const { data, error } = await db.rpc("rotate_compatibility_credential", {
      p_device_id: context.params.id, p_account_id: account?.accountId, p_credential_id: credentialId,
      p_ciphertext: credential.ciphertext, p_nonce: credential.nonce,
      p_valid_until: new Date(Date.now() + COMPATIBILITY_LIFETIME_MS).toISOString(),
      p_overlap_seconds: Math.floor(COMPATIBILITY_OVERLAP_MS / 1000),
    });
    if (error) throw new Error(`credential rotation failed: ${error.message}`);
    return data ? { status: 202, body: { rotating: true } } : { status: 404, body: { error: "External device not found" } };
  });
}
