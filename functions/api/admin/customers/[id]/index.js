import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../../../lib/admin-sanitize.js";
import { getAccountForUser, getLiveSubscription, getVpnAccountsForUser } from "../../../../lib/accounts.js";

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
    // F-07/C-06: a user can have 2+ provisioned identities (2+ devices) —
    // the normal case once a plan includes more than one device — so this
    // must not use .maybeSingle(), which 500s the moment that's true.
    const [{ data: user, error: userError }, vpnAccounts] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      getVpnAccountsForUser(supabaseAdmin, userId),
    ]);
    if (userError || !user?.user) {
      return jsonResponse({ error: "Customer not found" }, 404);
    }

    // Billing hangs off the account, so the subscription and Stripe customer
    // come from there rather than from this user directly — a member on
    // someone else's plan has no subscription row of their own.
    const account = await getAccountForUser(supabaseAdmin, userId);
    let sub = null;
    let stripeCustomerId = null;
    let accountSuspendedAt = null;
    let memberCount = 0;
    let grants = [];
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

      const [
        { data: accountRow, error: accountError },
        { count, error: memberCountError },
        { data: grantRows, error: grantError },
      ] = await Promise.all([
        supabaseAdmin
          .from("customer_accounts")
          .select("stripe_customer_id, suspended_at")
          .eq("id", account.accountId)
          .maybeSingle(),
        supabaseAdmin
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.accountId),
        supabaseAdmin
          .from("admin_entitlements")
          .select("id, status, starts_at, expires_at, seat_limit, reason, revoked_at, created_at")
          .eq("account_id", account.accountId)
          .order("created_at", { ascending: false }),
      ]);
      if (accountError) throw new Error(`customer_accounts query failed: ${accountError.message}`);
      if (memberCountError) throw new Error(`account_members count failed: ${memberCountError.message}`);
      if (grantError) throw new Error(`admin_entitlements query failed: ${grantError.message}`);
      stripeCustomerId = accountRow?.stripe_customer_id ?? null;
      accountSuspendedAt = accountRow?.suspended_at ?? null;
      memberCount = count ?? 0;
      grants = (grantRows ?? []).map((g) => ({
        id: g.id,
        status: g.status,
        startsAt: g.starts_at,
        expiresAt: g.expires_at,
        seatLimit: g.seat_limit,
        reason: g.reason,
        revokedAt: g.revoked_at,
        createdAt: g.created_at,
      }));
    }

    let jobs = [];
    if (vpnAccounts.length > 0) {
      const { data: jobRows, error: jobsError } = await supabaseAdmin
        .from("provisioning_jobs")
        .select("id, job_type, status, created_at, claimed_at, completed_at, result, vpn_account_id")
        .in(
          "vpn_account_id",
          vpnAccounts.map((v) => v.id)
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (jobsError) throw new Error(`provisioning_jobs query failed: ${jobsError.message}`);
      jobs = jobRows.map((j) => ({
        id: j.id,
        jobType: j.job_type,
        status: j.status,
        createdAt: j.created_at,
        claimedAt: j.claimed_at,
        completedAt: j.completed_at,
        result: sanitizeJobResult(j.result),
        vpnAccountId: j.vpn_account_id,
      }));
    }

    return jsonResponse({
      userId,
      email: user.user.email,
      accountId: account?.accountId ?? null,
      accountRole: account?.role ?? null,
      memberCount,
      suspendedAt: accountSuspendedAt,
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            stripeCustomerId,
            stripeSubscriptionId: sub.stripe_subscription_id,
          }
        : null,
      grants,
      // Plural now (F-07/C-06): a customer can have several provisioned
      // devices, and the admin UI needs to see and act on all of them.
      vpnAccounts: vpnAccounts.map((v) => ({
        id: v.id,
        vpnUserId: v.vpnUserId,
        nodeId: v.nodeId,
        enabled: v.enabled,
      })),
      jobs,
    });
  } catch (err) {
    console.error("admin/customers/:id: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
