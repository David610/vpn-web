import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
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

    for (const vpnAccount of vpnAccounts) {
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        idempotency_key: `admin-rotate-subscription:${vpnAccount.id}:${Date.now()}`,
        node_id: vpnAccount.nodeId,
        job_type: "ROTATE_SUBSCRIPTION_TOKEN",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpnUserId },
      });
      if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.rotate_subscription",
      targetType: "vpn_account",
      targetId: vpnAccounts.map((v) => v.id).join(","),
      metadata: { user_id: userId, device_count: vpnAccounts.length },
    });

    return jsonResponse({ ok: true, deviceCount: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/rotate: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
