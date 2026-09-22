import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../../../lib/admin-sanitize.js";
import { getAccountForUser, getLiveSubscription } from "../../../../lib/accounts.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  const userId = params.id;

  try {
    const [{ data: user, error: userError }, { data: vpnAccount, error: vpnError }] =
      await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin
          .from("vpn_accounts")
          .select("id, vpn_user_id, node_id, enabled")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);
    if (userError || !user?.user) {
      return jsonResponse({ error: "Customer not found" }, 404);
    }
    if (vpnError) throw new Error(`vpn_accounts query failed: ${vpnError.message}`);

    // Billing hangs off the account, so the subscription and Stripe customer
    // come from there rather than from this user directly — a member on
    // someone else's plan has no subscription row of their own.
    const account = await getAccountForUser(supabaseAdmin, userId);
    let sub = null;
    let stripeCustomerId = null;
    let memberCount = 0;
    if (account) {
      // Narrowed to the live statuses before maybeSingle(): an account that
      // lapsed and resubscribed keeps its old canceled rows, and only the
      // partial index subscriptions_account_active_uniq guarantees a single
      // match. Querying account_id alone would throw on the multi-row result.
      sub = await getLiveSubscription(
        supabaseAdmin,
        account.accountId,
        "status, current_period_end, cancel_at_period_end, stripe_subscription_id"
      );

      const [{ data: accountRow }, { count }] = await Promise.all([
        supabaseAdmin
          .from("customer_accounts")
          .select("stripe_customer_id")
          .eq("id", account.accountId)
          .maybeSingle(),
        supabaseAdmin
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.accountId),
      ]);
      stripeCustomerId = accountRow?.stripe_customer_id ?? null;
      memberCount = count ?? 0;
    }

    let jobs = [];
    if (vpnAccount) {
      const { data: jobRows, error: jobsError } = await supabaseAdmin
        .from("provisioning_jobs")
        .select("id, job_type, status, created_at, claimed_at, completed_at, result")
        .eq("vpn_account_id", vpnAccount.id)
        .order("created_at", { ascending: false });
      if (jobsError) throw new Error(`provisioning_jobs query failed: ${jobsError.message}`);
      jobs = jobRows.map((j) => ({
        id: j.id,
        jobType: j.job_type,
        status: j.status,
        createdAt: j.created_at,
        claimedAt: j.claimed_at,
        completedAt: j.completed_at,
        result: sanitizeJobResult(j.result),
      }));
    }

    return jsonResponse({
      userId,
      email: user.user.email,
      accountId: account?.accountId ?? null,
      accountRole: account?.role ?? null,
      memberCount,
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            stripeCustomerId,
            stripeSubscriptionId: sub.stripe_subscription_id,
          }
        : null,
      vpnAccount: vpnAccount
        ? { id: vpnAccount.id, vpnUserId: vpnAccount.vpn_user_id, nodeId: vpnAccount.node_id, enabled: vpnAccount.enabled }
        : null,
      jobs,
    });
  } catch (err) {
    console.error("admin/customers/:id: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
