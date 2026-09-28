import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
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

    const vpnAccounts = await getAccountVpnAccounts(supabaseAdmin, account.accountId);
    const jobs = vpnAccounts
      .filter((vpnAccount) => vpnAccount.enabled)
      .map((vpnAccount) => ({
        idempotency_key: `admin-disable-user:${vpnAccount.id}:${Date.now()}`,
        node_id: vpnAccount.nodeId,
        vpn_account_id: vpnAccount.id,
        vpn_user_id: vpnAccount.vpnUserId,
      }));

    // F-07/F-39: the account-wide suspend flag, the DISABLE_USER job
    // fan-out, and the audit row all commit in one transaction (see
    // admin_set_account_suspension_with_audit,
    // 20261008000000_admin_audit_transactional.sql) — a crash here can no
    // longer leave the account suspended with no audit trail, or vice
    // versa. The Auth ban call below is a separate GoTrue API request and
    // cannot join this transaction; see that migration's comment for why.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
      "admin_set_account_suspension_with_audit",
      {
        p_account_id: account.accountId,
        p_suspended: true,
        p_jobs: jobs,
        p_admin_user_id: admin.userId,
        p_action: "admin.disable_account",
        p_audit_metadata: { user_id: userId, device_count: vpnAccounts.length },
      }
    );
    if (rpcError) throw new Error(`admin_set_account_suspension_with_audit failed: ${rpcError.message}`);
    if (rpcResult?.status === "not_found") return jsonResponse({ error: "No account for this user" }, 404);

    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: "876000h", // ~100 years — effectively indefinite, lifted explicitly by enable.js
    });
    if (banError) throw new Error(`auth ban failed: ${banError.message}`);

    return jsonResponse({ ok: true, devicesRevoked: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/disable: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
