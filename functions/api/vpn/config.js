import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../../lib/crypto.js";
import { requireUser } from "../../lib/user-auth.js";
import { loadCustomerDashboardState } from "../../lib/dashboard-state.js";

export async function onRequestGet({ env, request }) {
  const noStoreJson = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const state = await loadCustomerDashboardState(supabaseAdmin, user);
    if (!state) return noStoreJson({ error: "No active subscription" }, 403);

    if (!state.entitlement) {
      const reservationFresh =
        state.trial.reservedAt &&
        Date.now() - new Date(state.trial.reservedAt).getTime() < 24 * 60 * 60 * 1000;
      return noStoreJson(
        {
          error: "No active subscription",
          code: "no_subscription",
          trial_available:
            !state.trial.usedAt &&
            (!reservationFresh || Boolean(state.trial.checkoutSessionId)),
        },
        403
      );
    }

    const vpnAccount = state.vpnAccount;
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
        entitlement_source: state.entitlement.source,
        status: state.entitlement.status,
        current_period_end: state.entitlement.currentPeriodEnd,
        cancel_at_period_end: state.entitlement.cancelAtPeriodEnd,
        account: state.overview,
      },
      200
    );
  } catch (err) {
    console.error("vpn/config: failed:", err.message);
    return noStoreJson({ error: "Internal error" }, 500);
  }
}
