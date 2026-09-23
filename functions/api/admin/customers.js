import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

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
