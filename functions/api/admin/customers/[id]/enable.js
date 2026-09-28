import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { getAccountForUser, getAccountVpnAccounts } from "../../../../lib/accounts.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * F-07/C-06: the account-level counterpart of disable.js. Clears
 * customer_accounts.suspended_at, lifts the auth ban, and re-enables every
 * device that this endpoint (not some other cause) had disabled. This is an
 * explicit admin action, not the automatic reconcile path — reconcile must
 * never clear suspended_at on its own (device_entitlement() blocks
 * entitlement for as long as suspended_at is set, regardless of what any
 * Stripe event reports).
 */
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
    const account = await getAccountForUser(supabaseAdmin, userId);
    if (!account) return jsonResponse({ error: "No account for this user" }, 404);

    const vpnAccounts = await getAccountVpnAccounts(supabaseAdmin, account.accountId);
    const jobs = vpnAccounts
      .filter((vpnAccount) => !vpnAccount.enabled)
      .map((vpnAccount) => ({
        idempotency_key: `admin-enable-user:${vpnAccount.id}:${Date.now()}`,
        node_id: vpnAccount.nodeId,
        vpn_account_id: vpnAccount.id,
        vpn_user_id: vpnAccount.vpnUserId,
      }));

    // F-07/F-39: see disable.js — same single-transaction coupling of the
    // suspend flag, the ENABLE_USER job fan-out, and the audit row.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
      "admin_set_account_suspension_with_audit",
      {
        p_account_id: account.accountId,
        p_suspended: false,
        p_jobs: jobs,
        p_admin_user_id: admin.userId,
        p_action: "admin.enable_account",
        p_audit_metadata: { user_id: userId, device_count: vpnAccounts.length },
      }
    );
    if (rpcError) throw new Error(`admin_set_account_suspension_with_audit failed: ${rpcError.message}`);
    if (rpcResult?.status === "not_found") return jsonResponse({ error: "No account for this user" }, 404);

    const { error: unbanError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (unbanError) throw new Error(`auth unban failed: ${unbanError.message}`);

    return jsonResponse({ ok: true, devicesReenabled: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/enable: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
