import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sum(rows, key) {
  return (rows ?? []).reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const nowIso = new Date().toISOString();
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const results = await Promise.all([
      supabaseAdmin.from("customer_accounts").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "trialing"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "past_due"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "canceled"),
      supabaseAdmin.from("account_members").select("id", { count: "exact", head: true }),
      supabaseAdmin
        .from("member_invites")
        .select("id", { count: "exact", head: true })
        .is("accepted_at", null)
        .is("revoked_at", null)
        .gt("expires_at", nowIso),
      supabaseAdmin
        .from("admin_entitlements")
        .select("id", { count: "exact", head: true })
        .eq("status", "active"),
      supabaseAdmin
        .from("subscriptions")
        .select("extra_seats")
        .in("status", ["trialing", "active", "past_due"]),
      supabaseAdmin.from("vpn_accounts").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("vpn_accounts").select("id", { count: "exact", head: true }).eq("enabled", true),
      supabaseAdmin.from("vpn_accounts").select("id", { count: "exact", head: true }).eq("enabled", false),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "claimed"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin.from("nodes").select("last_seen_at, revoked_at"),
      supabaseAdmin.from("vpn_usage_current").select("download_bps, upload_bps"),
      supabaseAdmin
        .from("vpn_usage_hourly")
        .select("download_bytes, upload_bytes")
        .gte("hour", monthStart.toISOString()),
      supabaseAdmin
        .from("operational_alerts")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),
      supabaseAdmin
        .from("abuse_signals")
        .select("id", { count: "exact", head: true })
        .eq("review_status", "open")
        .eq("flagged", true),
    ]);

    for (const result of results) {
      if (result.error) throw new Error(result.error.message);
    }

    const [
      accounts, active, trialing, pastDue, canceled, members, invites, grants,
      seatRows, vpnTotal, vpnEnabled, vpnDisabled, jobsPending, jobsClaimed,
      jobsFailed, nodesResult, currentUsage, monthlyUsage, alerts, abuse,
    ] = results;

    const now = Date.now();
    const nodeRows = nodesResult.data ?? [];
    const online = nodeRows.filter(
      (n) => !n.revoked_at && n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 90_000
    ).length;
    const nonRevoked = nodeRows.filter((n) => !n.revoked_at).length;

    const downloadBps = sum(currentUsage.data, "download_bps");
    const uploadBps = sum(currentUsage.data, "upload_bps");
    const monthDownload = sum(monthlyUsage.data, "download_bytes");
    const monthUpload = sum(monthlyUsage.data, "upload_bytes");

    return jsonResponse({
      customers: {
        total: accounts.count ?? 0,
        active: active.count ?? 0,
        trialing: trialing.count ?? 0,
        past_due: pastDue.count ?? 0,
        canceled: canceled.count ?? 0,
      },
      members: {
        active: members.count ?? 0,
        pending_invites: invites.count ?? 0,
        admin_grants: grants.count ?? 0,
        paid_extra_seats: sum(seatRows.data, "extra_seats"),
      },
      vpn: {
        accounts: vpnTotal.count ?? 0,
        enabled: vpnEnabled.count ?? 0,
        disabled: vpnDisabled.count ?? 0,
      },
      jobs: {
        pending: jobsPending.count ?? 0,
        claimed: jobsClaimed.count ?? 0,
        failed: jobsFailed.count ?? 0,
      },
      nodes: { online, offline: Math.max(0, nonRevoked - online) },
      usage: {
        download_bps: downloadBps,
        upload_bps: uploadBps,
        month_download_bytes: monthDownload,
        month_upload_bytes: monthUpload,
        month_total_bytes: monthDownload + monthUpload,
      },
      alerts: { open: alerts.count ?? 0 },
      abuse: { open: abuse.count ?? 0 },
    });
  } catch (err) {
    console.error("admin/overview: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
