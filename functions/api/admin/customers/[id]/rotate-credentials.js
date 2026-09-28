import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { getVpnAccountsForUser } from "../../../../lib/accounts.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    // F-07/C-06: fan out over every identity this user has, rather than
    // assuming exactly one (.maybeSingle() 500s once a user has 2+ devices).
    const vpnAccounts = await getVpnAccountsForUser(supabaseAdmin, userId);
    if (vpnAccounts.length === 0) return jsonResponse({ error: "No VPN account for this user" }, 404);

    for (const vpnAccount of vpnAccounts) {
      const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
        idempotency_key: `admin-rotate-credentials:${vpnAccount.id}:${crypto.randomUUID()}`,
        node_id: vpnAccount.nodeId,
        job_type: "ROTATE_CREDENTIALS",
        vpn_account_id: vpnAccount.id,
        payload: { vpn_user_id: vpnAccount.vpnUserId },
      });
      if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.rotate_credentials",
      targetType: "vpn_account",
      targetId: vpnAccounts.map((v) => v.id).join(","),
      metadata: { user_id: userId, device_count: vpnAccounts.length },
    });

    return jsonResponse({ ok: true, deviceCount: vpnAccounts.length });
  } catch (err) {
    console.error("admin/customers/:id/rotate-credentials: failed:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
