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

const STATUSES = new Set(["incomplete", "trialing", "active", "past_due", "canceled", "unpaid"]);

/** Every subscription with its owner, capacity and devices in use. */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("q")?.trim().slice(0, 120) ?? "";
    const statusParam = url.searchParams.get("status");
    const status = statusParam && STATUSES.has(statusParam) ? statusParam : null;
    const page = boundedInt(url.searchParams.get("page"), 1, 1, 1_000_000);
    const perPage = boundedInt(url.searchParams.get("per_page"), 50, 10, 100);

    const { data, error } = await supabaseAdmin.rpc("admin_subscription_directory", {
      p_query: q || null,
      p_status: status,
      p_limit: perPage,
      p_offset: (page - 1) * perPage,
    });
    if (error) throw new Error(`admin_subscription_directory failed: ${error.message}`);

    const rows = data ?? [];
    const total = rows.length ? Number(rows[0].total_count) || 0 : 0;
    return jsonResponse({
      subscriptions: rows.map((r) => ({
        id: String(r.subscription_id),
        accountId: r.account_id,
        ownerUserId: r.owner_user_id ?? null,
        ownerEmail: r.owner_email ?? null,
        name: r.name,
        status: r.status,
        cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
        currentPeriodEnd: r.current_period_end ?? null,
        extraPacks: Math.ceil((Number(r.extra_seats) || 0) / 3),
        capacity: Number(r.device_capacity) || 3,
        activeDevices: Number(r.active_devices) || 0,
        stripeSubscriptionId: r.stripe_subscription_id ?? null,
        createdAt: r.created_at,
      })),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error("admin/subscriptions: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
