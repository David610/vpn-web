import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { deviceCapacity } from "../../lib/seat-constants.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function boundedInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

/**
 * Link and client counts and device capacity for the accounts on this page, in
 * three bounded queries. Counts only: never a link, token or URL. A failure here
 * costs the extra columns, not the directory.
 */
async function linkStats(supabaseAdmin, accountIds) {
  const stats = new Map(accountIds.map((id) => [id, { linkCount: 0, clientCount: 0, capacity: 0 }]));
  if (accountIds.length === 0) return stats;
  try {
    const [links, clients, subscriptions] = await Promise.all([
      supabaseAdmin.from("vpn_links").select("account_id").in("account_id", accountIds).eq("status", "active"),
      supabaseAdmin.from("external_vpn_devices").select("account_id").in("account_id", accountIds).is("revoked_at", null),
      supabaseAdmin.from("subscriptions").select("account_id, extra_seats").in("account_id", accountIds).in("status", LIVE_SUBSCRIPTION_STATUSES),
    ]);
    for (const result of [links, clients, subscriptions]) if (result.error) throw new Error(result.error.message);
    for (const row of links.data ?? []) stats.get(row.account_id).linkCount += 1;
    for (const row of clients.data ?? []) stats.get(row.account_id).clientCount += 1;
    for (const row of subscriptions.data ?? []) stats.get(row.account_id).capacity += deviceCapacity(row.extra_seats);
    return stats;
  } catch (err) {
    console.error("admin/customers: link stats failed:", err.message);
    return null;
  }
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const page = boundedInt(url.searchParams.get("page"), 1, 1, 1_000_000);
    const perPage = boundedInt(url.searchParams.get("per_page"), 50, 10, 100);
    const offset = (page - 1) * perPage;

    const { data, error } = await supabaseAdmin.rpc("admin_customer_directory", {
      p_query: q || null,
      p_limit: perPage,
      p_offset: offset,
    });
    if (error) throw new Error(`admin_customer_directory failed: ${error.message}`);

    const rows = data ?? [];
    const stats = await linkStats(supabaseAdmin, [...new Set(rows.map((r) => r.account_id).filter(Boolean))]);
    const total = rows.length ? Number(rows[0].total_count) || 0 : 0;
    const customers = rows.map((row) => ({
      userId: row.user_id,
      accountId: row.account_id,
      accountRole: row.account_role,
      memberCount: Number(row.member_count) || 1,
      email: row.email ?? null,
      subscriptionStatus: row.subscription_status ?? null,
      currentPeriodEnd: row.current_period_end ?? null,
      vpnAccountId: row.vpn_account_id ?? null,
      vpnUserId: row.vpn_user_id ?? null,
      nodeId: row.node_id ?? null,
      enabled: row.enabled ?? null,
      linkCount: stats?.get(row.account_id)?.linkCount ?? null,
      clientCount: stats?.get(row.account_id)?.clientCount ?? null,
      capacity: stats?.get(row.account_id)?.capacity ?? null,
    }));

    return jsonResponse({
      customers,
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error("admin/customers: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
