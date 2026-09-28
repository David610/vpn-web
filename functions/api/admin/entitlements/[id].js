import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { getEffectiveEntitlement } from "../../../lib/accounts.js";
import { syncAccountProvisioningToEntitlement } from "../../../lib/provision-entitlement.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestDelete({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") return json({ error: "Read-only admins cannot revoke access." }, 403);

  try {
    // F-39 round 2: the admin_entitlements revoke and its admin_audit_log
    // row commit together in a single RPC (see
    // 20261010000000_admin_audit_transactional_round2.sql), so a crash
    // between them can no longer leave an unaudited revoke or an audit row
    // for a revoke that never happened.
    const { data: rpcResult, error: revokeError } = await supabaseAdmin.rpc(
      "admin_revoke_entitlement_with_audit",
      {
        p_grant_id: params.id,
        p_admin_user_id: admin.userId,
        p_audit_metadata: {},
      }
    );
    if (revokeError) throw new Error(`grant revoke failed: ${revokeError.message}`);
    if (rpcResult?.status === "not_found") return json({ error: "Grant not found." }, 404);
    if (rpcResult?.status === "duplicate") return json({ ok: true, duplicate: true });

    const entitlement = await getEffectiveEntitlement(supabaseAdmin, rpcResult.account_id);
    await syncAccountProvisioningToEntitlement(
      supabaseAdmin,
      rpcResult.account_id,
      entitlement,
      `admin-revoke:${params.id}`,
      env
    );

    return json({ ok: true });
  } catch (err) {
    console.error("admin/entitlements/:id: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
