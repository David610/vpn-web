import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// v1 simplification: fetches all subscriptions/vpn_accounts and joins in
// memory, since auth.users (needed for email) is not queryable via
// PostgREST even for service_role — only the GoTrue admin API can look
// it up, and that API has no server-side "join with a public table"
// primitive. Fine at the customer counts docs/DEVICE_ACCEPTANCE_TESTS.md-
// style examples show (dozens); revisit with real SQL pagination if this
// grows into the thousands.
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";

    const [
      { data: members, error: membersError },
      { data: subs, error: subsError },
      { data: vpnAccounts, error: vpnError },
      { data: usersPage, error: usersError },
    ] = await Promise.all([
      supabaseAdmin.from("account_members").select("account_id, user_id, role"),
      supabaseAdmin
        .from("subscriptions")
        .select("account_id, status, current_period_end")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("vpn_accounts").select("id, user_id, vpn_user_id, node_id, enabled"),
      supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
    ]);
    if (membersError) throw new Error(`account_members query failed: ${membersError.message}`);
    if (subsError) throw new Error(`subscriptions query failed: ${subsError.message}`);
    if (vpnError) throw new Error(`vpn_accounts query failed: ${vpnError.message}`);
    if (usersError) throw new Error(`listUsers failed: ${usersError.message}`);

    const emailByUserId = new Map(usersPage.users.map((u) => [u.id, u.email]));
    const vpnByUserId = new Map(vpnAccounts.map((v) => [v.user_id, v]));

    // Most recent subscription row per account. An account that lapsed and
    // resubscribed keeps its old canceled rows forever, so taking the first
    // of a created_at-descending list is what makes this the *current*
    // status rather than an arbitrary historical one.
    const subByAccount = new Map();
    for (const sub of subs) {
      if (!subByAccount.has(sub.account_id)) subByAccount.set(sub.account_id, sub);
    }

    const memberCountByAccount = new Map();
    for (const m of members) {
      memberCountByAccount.set(m.account_id, (memberCountByAccount.get(m.account_id) ?? 0) + 1);
    }

    // One row per person, not per subscription row. Iterating members rather
    // than subscriptions is what keeps a resubscriber from appearing once
    // per historical subscription: account_members.user_id is unique, so
    // each person can only be listed once.
    let customers = members.map((m) => {
      const vpn = vpnByUserId.get(m.user_id);
      const sub = subByAccount.get(m.account_id);
      return {
        userId: m.user_id,
        accountId: m.account_id,
        accountRole: m.role,
        memberCount: memberCountByAccount.get(m.account_id) ?? 1,
        email: emailByUserId.get(m.user_id) ?? null,
        subscriptionStatus: sub?.status ?? null,
        currentPeriodEnd: sub?.current_period_end ?? null,
        vpnAccountId: vpn?.id ?? null,
        vpnUserId: vpn?.vpn_user_id ?? null,
        nodeId: vpn?.node_id ?? null,
        enabled: vpn?.enabled ?? null,
      };
    });

    if (q) {
      customers = customers.filter(
        (c) =>
          c.email?.toLowerCase().includes(q) ||
          c.userId.toLowerCase().includes(q) ||
          c.vpnUserId?.toLowerCase().includes(q)
      );
    }

    return jsonResponse({ customers });
  } catch (err) {
    console.error("admin/customers: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
