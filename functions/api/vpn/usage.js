import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const { data: vpnAccount, error: vpnError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vpnError) throw new Error(`vpn account lookup failed: ${vpnError.message}`);
    if (!vpnAccount) return jsonResponse({ available: false, reason: "not_provisioned" });

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [{ data: current, error: currentError }, { data: hourly, error: hourlyError }] =
      await Promise.all([
        supabaseAdmin
          .from("vpn_usage_current")
          .select("sampled_at, download_bps, upload_bps, last_seen_at")
          .eq("vpn_account_id", vpnAccount.id)
          .maybeSingle(),
        supabaseAdmin
          .from("vpn_usage_hourly")
          .select("download_bytes, upload_bytes")
          .eq("vpn_account_id", vpnAccount.id)
          .gte("hour", monthStart),
      ]);
    if (currentError) throw new Error(`usage current lookup failed: ${currentError.message}`);
    if (hourlyError) throw new Error(`usage hourly lookup failed: ${hourlyError.message}`);
    if (!current) return jsonResponse({ available: false, reason: "no_samples" });

    const totals = (hourly ?? []).reduce(
      (acc, row) => {
        acc.download += Number(row.download_bytes) || 0;
        acc.upload += Number(row.upload_bytes) || 0;
        return acc;
      },
      { download: 0, upload: 0 }
    );

    return jsonResponse({
      available: true,
      sampled_at: current.sampled_at,
      last_seen_at: current.last_seen_at,
      download_bps: Number(current.download_bps) || 0,
      upload_bps: Number(current.upload_bps) || 0,
      month_download_bytes: totals.download,
      month_upload_bytes: totals.upload,
      month_total_bytes: totals.download + totals.upload,
    });
  } catch (err) {
    console.error("vpn/usage: failed:", err.message);
    return jsonResponse({ error: "Could not load usage." }, 500);
  }
}
