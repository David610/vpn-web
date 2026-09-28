import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { getAccountForUser, getAccountVpnAccounts } from "../../../../lib/accounts.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * F-07/C-06: suspends the account, not a single vpn_accounts row.
 *
 * customer_accounts.suspended_at (device_entitlement() already honors it —
 * see 20261001000000_device_entitlement.sql) is the durable flag: it blocks
 * entitlement account-wide regardless of how many devices/identities the
 * account has, and a subsequent Stripe reconcile can never clear it (only
 * this endpoint's counterpart, enable.js, can). Every provisioned identity
 * on the account is also urgently revoked so access stops immediately
 * rather than at the next reconcile tick.
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

    const { error: suspendError } = await supabaseAdmin
      .from("customer_accounts")
      .update({ suspended_at: new Date().toISOString() })
      .eq("id", account.accountId);
    if (suspendError) throw new Error(`customer_accounts suspend failed: ${suspendError.message}`);

    const vpnAccounts = await getAccountVpnAccounts(supabaseAdmin, account.accountId);
    for (const vpnAccount of vpnAccounts) {
      if (!vpnAccount.enabled) continue;
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        idempotency_key: `admin-disable-user:${vpnAccount.id}:${Date.now()}`,
        node_id: vpnAccount.nodeId,
        job_type: "DISABLE_USER",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpnUserId },
      });
      if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }

    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "876000h", // ~100 years — effectively indefinite, lifted explicitly by enable.js
    });
    if (banError) throw new Error(`auth ban failed: ${banError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.disable_account",
      targetType: "customer_account",
      targetId: account.accountId,
      metadata: { user_id: userId, device_count: vpnAccounts.length },
    });

    return jsonResponse({ ok: true, devicesRevoked: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/disable: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
