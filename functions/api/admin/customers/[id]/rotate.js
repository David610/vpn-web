import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { getVpnAccountsForUser } from "../../../../lib/accounts.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") {
    return jsonResponse({ error: "Read-only admins cannot perform this action" }, 403);
  }

  const userId = params.id;

  try {
    // F-07/C-06: a user can have 2+ provisioned identities (2+ devices) —
    // the normal case — so this fans out over all of them instead of
    // assuming exactly one row (.maybeSingle() 500s the moment that's false).
    const vpnAccounts = await getVpnAccountsForUser(supabaseAdmin, userId);
    if (vpnAccounts.length === 0) return jsonResponse({ error: "No VPN account for this user" }, 404);

    // F-39 round 2: the per-device provisioning_jobs inserts and the audit
    // row commit together in a single RPC (see
    // 20261010000000_admin_audit_transactional_round2.sql), so a crash
    // partway through the fan-out can no longer leave some jobs enqueued
    // with no audit row, or an audit row for jobs that never landed.
    const jobs = vpnAccounts.map((vpnAccount) => ({
      idempotency_key: `admin-rotate-subscription:${vpnAccount.id}:${Date.now()}:${crypto.randomUUID()}`,
      node_id: vpnAccount.nodeId,
      vpn_account_id: vpnAccount.id,
      vpn_user_id: vpnAccount.vpnUserId,
    }));
    const { error: rpcError } = await supabaseAdmin.rpc("admin_insert_jobs_with_audit", {
      p_job_type: "ROTATE_SUBSCRIPTION_TOKEN",
      p_jobs: jobs,
      p_admin_user_id: admin.userId,
      p_action: "admin.rotate_subscription",
      p_target_type: "vpn_account",
      p_target_id: vpnAccounts.map((v) => v.id).join(","),
      p_audit_metadata: { user_id: userId, device_count: vpnAccounts.length },
    });
    if (rpcError) throw new Error(`provisioning_jobs insert failed: ${rpcError.message}`);

    return jsonResponse({ ok: true, deviceCount: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/rotate: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
