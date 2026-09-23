import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data: signals, error } = await supabaseAdmin
      .from("abuse_signals")
      .select("id, vpn_account_id, distinct_ip_count, window_start, window_end, flagged, review_status, reviewed_at, created_at")
      .eq("flagged", true)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const accountIds = [...new Set((signals ?? []).map((s) => s.vpn_account_id))];
    let vpnRows = [];
    if (accountIds.length) {
      const { data, error: vpnError } = await supabaseAdmin
        .from("vpn_accounts")
        .select("id, user_id, vpn_user_id, node_id, enabled")
        .in("id", accountIds);
      if (vpnError) throw new Error(vpnError.message);
      vpnRows = data ?? [];
    }
    const vpnById = new Map(vpnRows.map((v) => [v.id, v]));

    return json({
      signals: (signals ?? []).map((s) => {
        const vpn = vpnById.get(s.vpn_account_id);
        return {
          id: s.id,
          vpnAccountId: s.vpn_account_id,
          userId: vpn?.user_id ?? null,
          vpnUserId: vpn?.vpn_user_id ?? null,
          nodeId: vpn?.node_id ?? null,
          vpnEnabled: vpn?.enabled ?? null,
          distinctIpCount: s.distinct_ip_count,
          windowStart: s.window_start,
          windowEnd: s.window_end,
          reviewStatus: s.review_status,
          reviewedAt: s.reviewed_at,
          createdAt: s.created_at,
        };
      }),
    });
  } catch (err) {
    console.error("admin/abuse: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
