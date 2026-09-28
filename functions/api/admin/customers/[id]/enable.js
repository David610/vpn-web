import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
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

    const { error: unsuspendError } = await supabaseAdmin
      .from("customer_accounts")
      .update({ suspended_at: null })
      .eq("id", account.accountId);
    if (unsuspendError) throw new Error(`customer_accounts unsuspend failed: ${unsuspendError.message}`);

    const vpnAccounts = await getAccountVpnAccounts(supabaseAdmin, account.accountId);
    for (const vpnAccount of vpnAccounts) {
      if (vpnAccount.enabled) continue;
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        idempotency_key: `admin-enable-user:${vpnAccount.id}:${Date.now()}`,
        node_id: vpnAccount.nodeId,
        job_type: "ENABLE_USER",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpnUserId },
      });
      if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }

    const { error: unbanError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "none",
    });
    if (unbanError) throw new Error(`auth unban failed: ${unbanError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.enable_account",
      targetType: "customer_account",
      targetId: account.accountId,
      metadata: { user_id: userId, device_count: vpnAccounts.length },
    });

    return jsonResponse({ ok: true, devicesReenabled: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/enable: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
