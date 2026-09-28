import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser, getEffectiveEntitlement } from "../../lib/accounts.js";
import { checkNodeMutationBudget } from "../../lib/node-mutation-budget.js";
import { rateLimitedResponse } from "../../lib/rate-limit.js";

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

    const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
    if (!entitlement) return jsonResponse({ error: "No active entitlement" }, 403);

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

    // F-10 (P1): a rotate applies through vpn-admin -> sing-box
    // reload-or-restart on the node, dropping every open connection there,
    // not just this account's. Budget this per account/node so it can't be
    // triggered repeatedly for free (functions/lib/node-mutation-budget.js).
    const withinBudget = await checkNodeMutationBudget(supabaseAdmin, account.accountId, vpnAccount.node_id);
    if (!withinBudget) {
      return rateLimitedResponse("Too many credential rotations for this connection recently. Please try again later.");
    }

    // Deterministic within a short window so a client retry (or a user
    // double-clicking) coalesces into one node mutation instead of two --
    // a random key per call was the same restart-DoS shape the budget
    // check above now limits by volume.
    const windowMinutes = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `self-rotate-credentials:${vpnAccount.id}:${windowMinutes}`;
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
