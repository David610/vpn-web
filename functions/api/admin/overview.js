import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const [
      { count: activeCount, error: activeError },
      { count: pastDueCount, error: pastDueError },
      { count: canceledCount, error: canceledError },
      { count: totalSubs, error: totalSubsError },
      { count: vpnAccountCount, error: vpnAccountError },
      { count: pendingJobs, error: pendingJobsError },
      { count: claimedJobs, error: claimedJobsError },
      { count: failedJobs, error: failedJobsError },
      { data: nodes, error: nodesError },
    ] = await Promise.all([
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).in("status", ["trialing", "active"]),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "past_due"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "canceled"),
      supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("vpn_accounts").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "claimed"),
      supabaseAdmin.from("provisioning_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin.from("nodes").select("last_seen_at, revoked_at"),
    ]);
    if (activeError) throw new Error(`active subscriptions count failed: ${activeError.message}`);
    if (pastDueError) throw new Error(`past_due subscriptions count failed: ${pastDueError.message}`);
    if (canceledError) throw new Error(`canceled subscriptions count failed: ${canceledError.message}`);
    if (totalSubsError) throw new Error(`total subscriptions count failed: ${totalSubsError.message}`);
    if (vpnAccountError) throw new Error(`vpn_accounts count failed: ${vpnAccountError.message}`);
    if (pendingJobsError) throw new Error(`pending jobs count failed: ${pendingJobsError.message}`);
    if (claimedJobsError) throw new Error(`claimed jobs count failed: ${claimedJobsError.message}`);
    if (failedJobsError) throw new Error(`failed jobs count failed: ${failedJobsError.message}`);
    if (nodesError) throw new Error(`nodes query failed: ${nodesError.message}`);

    const now = Date.now();
    const onlineCount = (nodes ?? []).filter(
      (n) => !n.revoked_at && n.last_seen_at && now - new Date(n.last_seen_at).getTime() < 45_000
    ).length;
    const offlineCount = (nodes ?? []).filter((n) => !n.revoked_at).length - onlineCount;

    return jsonResponse({
      customers: { total: totalSubs ?? 0, active: activeCount ?? 0, past_due: pastDueCount ?? 0, canceled: canceledCount ?? 0 },
      vpn: { accounts: vpnAccountCount ?? 0 },
      jobs: { pending: pendingJobs ?? 0, claimed: claimedJobs ?? 0, failed: failedJobs ?? 0 },
      nodes: { online: onlineCount, offline: offlineCount },
    });
  } catch (err) {
    console.error("admin/overview: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
