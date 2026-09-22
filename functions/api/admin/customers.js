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

    const [{ data: subs, error: subsError }, { data: vpnAccounts, error: vpnError }, { data: usersPage, error: usersError }] =
      await Promise.all([
        supabaseAdmin.from("subscriptions").select("user_id, status, current_period_end").order("created_at", { ascending: false }),
        supabaseAdmin.from("vpn_accounts").select("id, user_id, vpn_user_id, node_id, enabled"),
        supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
      ]);
    if (subsError) throw new Error(`subscriptions query failed: ${subsError.message}`);
    if (vpnError) throw new Error(`vpn_accounts query failed: ${vpnError.message}`);
    if (usersError) throw new Error(`listUsers failed: ${usersError.message}`);

    const emailByUserId = new Map(usersPage.users.map((u) => [u.id, u.email]));
    const vpnByUserId = new Map(vpnAccounts.map((v) => [v.user_id, v]));

    // Deduplicate by userId, keeping the first (most-recent) row per user.
    // A resubscriber has multiple subscriptions rows; created_at DESC ordering
    // above means index 0 is always the most recent subscription.
    const seenUserIds = new Set();
    let customers = subs.reduce((acc, sub) => {
      if (seenUserIds.has(sub.user_id)) return acc;
      seenUserIds.add(sub.user_id);
      const vpn = vpnByUserId.get(sub.user_id);
      acc.push({
        userId: sub.user_id,
        email: emailByUserId.get(sub.user_id) ?? null,
        subscriptionStatus: sub.status,
        currentPeriodEnd: sub.current_period_end,
        vpnAccountId: vpn?.id ?? null,
        vpnUserId: vpn?.vpn_user_id ?? null,
        nodeId: vpn?.node_id ?? null,
        enabled: vpn?.enabled ?? null,
      });
      return acc;
    }, []);

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
