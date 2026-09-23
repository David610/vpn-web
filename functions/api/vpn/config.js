import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../../lib/crypto.js";
import { getAccountForUser, getEffectiveEntitlement } from "../../lib/accounts.js";

export async function onRequestGet({ env, request }) {
  const noStoreJson = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return noStoreJson({ error: "Authorization required" }, 401);

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) return noStoreJson({ error: "Invalid or expired token" }, 401);

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) return noStoreJson({ error: "No active subscription" }, 403);

    const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
    if (!entitlement) return noStoreJson({ error: "No active subscription" }, 403);

    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, enabled")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vpnAccountError) {
      throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    }
    if (!vpnAccount) return noStoreJson({ error: "Provisioning still in progress" }, 404);
    if (!vpnAccount.enabled) return noStoreJson({ error: "VPN access is disabled" }, 403);

    const { data: secret, error: secretError } = await supabaseAdmin
      .from("vpn_secrets")
      .select("ciphertext, nonce, provisioning_ciphertext, provisioning_nonce")
      .eq("vpn_account_id", vpnAccount.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (secretError) throw new Error(`vpn_secrets lookup failed: ${secretError.message}`);
    if (!secret) return noStoreJson({ error: "Provisioning still in progress" }, 404);

    const subscriptionUrl = await decryptSecret(
      secret.ciphertext,
      secret.nonce,
      env.VPN_SECRETS_ENCRYPTION_KEY
    );

    let provisioningUrl = null;
    if (secret.provisioning_ciphertext && secret.provisioning_nonce) {
      provisioningUrl = await decryptSecret(
        secret.provisioning_ciphertext,
        secret.provisioning_nonce,
        env.VPN_SECRETS_ENCRYPTION_KEY
      );
    }

    return noStoreJson(
      {
        subscription_url: subscriptionUrl,
        provisioning_url: provisioningUrl,
        preferred_setup_url: provisioningUrl ?? subscriptionUrl,
        entitlement_source: entitlement.source,
        status: entitlement.status,
        current_period_end: entitlement.currentPeriodEnd,
        cancel_at_period_end: entitlement.cancelAtPeriodEnd,
      },
      200
    );
  } catch (err) {
    console.error("vpn/config: failed:", err.message);
    return noStoreJson({ error: "Internal error" }, 500);
  }
}
