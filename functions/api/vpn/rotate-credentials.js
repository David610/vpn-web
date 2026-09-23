import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser, getLiveSubscription } from "../../lib/accounts.js";

/**
 * Rotates the caller's actual VLESS + Hysteria2 credentials.
 *
 * The existing provisioning URL remains the recovery channel and will render
 * the new credentials after the job completes. Because this invalidates
 * already-imported credentials, a recently authenticated session is required.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) return jsonResponse({ error: "Account not found" }, 404);

    const subscription = await getLiveSubscription(
      supabaseAdmin,
      account.accountId,
      "id"
    );
    if (!subscription) return jsonResponse({ error: "No active subscription" }, 403);

    const { data: vpnAccount, error } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, vpn_user_id, node_id, enabled")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);
    if (!vpnAccount) return jsonResponse({ error: "VPN is still provisioning." }, 409);
    if (!vpnAccount.enabled) return jsonResponse({ error: "VPN access is disabled." }, 403);

    const idempotencyKey = `self-rotate-credentials:${vpnAccount.id}:${crypto.randomUUID()}`;
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .insert({
        idempotency_key: idempotencyKey,
        node_id: vpnAccount.node_id,
        job_type: "ROTATE_CREDENTIALS",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpn_user_id },
      })
      .select("id")
      .single();
    if (jobError) throw new Error(`provisioning job insert failed: ${jobError.message}`);

    return jsonResponse({ ok: true, job_id: job.id }, 202);
  } catch (err) {
    console.error("vpn/rotate-credentials: failed:", err.message);
    return jsonResponse({ error: "Could not rotate VPN credentials." }, 500);
  }
}
