import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../../lib/crypto.js";

export async function onRequestGet({ env, request }) {
  const noStoreJson = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return noStoreJson({ error: "Authorization required" }, 401);
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) {
      return noStoreJson({ error: "Invalid or expired token" }, 401);
    }

    // Narrowed to status = 'active' before .maybeSingle(): subscriptions
    // has no unique constraint on user_id alone (a canceled-then-
    // resubscribed customer can have 2+ rows), only a partial unique
    // index on (user_id) where status in ('trialing','active','past_due')
    // (subscriptions_user_active_uniq). Querying user_id alone can match
    // multiple rows for a real (not corner-case) flow, and .maybeSingle()
    // throws on a multi-row result. Adding status = 'active' guarantees
    // at most one match via that same partial index, so this can't become
    // a new multi-row hazard itself.
    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (subError) throw new Error(`subscriptions lookup failed: ${subError.message}`);
    if (!subscription) {
      return noStoreJson({ error: "No active subscription" }, 403);
    }

    const { data: vpnAccount, error: vpnAccountError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vpnAccountError) throw new Error(`vpn_accounts lookup failed: ${vpnAccountError.message}`);
    if (!vpnAccount) {
      return noStoreJson({ error: "Provisioning still in progress" }, 404);
    }

    const { data: secret, error: secretError } = await supabaseAdmin
      .from("vpn_secrets")
      .select("ciphertext, nonce")
      .eq("vpn_account_id", vpnAccount.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (secretError) throw new Error(`vpn_secrets lookup failed: ${secretError.message}`);
    if (!secret) {
      return noStoreJson({ error: "Provisioning still in progress" }, 404);
    }

    const subscriptionUrl = await decryptSecret(secret.ciphertext, secret.nonce, env.VPN_SECRETS_ENCRYPTION_KEY);
    return noStoreJson({ subscription_url: subscriptionUrl }, 200);
  } catch (err) {
    console.error("vpn/config: failed:", err.message);
    return noStoreJson({ error: "Internal error" }, 500);
  }
}
