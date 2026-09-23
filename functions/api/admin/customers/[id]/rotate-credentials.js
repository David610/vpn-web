import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";

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
    const { data: vpnAccount, error: vpnError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id, node_id, vpn_user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (vpnError) throw new Error(`vpn_accounts lookup failed: ${vpnError.message}`);
    if (!vpnAccount) return jsonResponse({ error: "No VPN account for this user" }, 404);

    const { error: jobError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: `admin-rotate-credentials:${vpnAccount.id}:${crypto.randomUUID()}`,
      node_id: vpnAccount.node_id,
      job_type: "ROTATE_CREDENTIALS",
      vpn_account_id: vpnAccount.id,
      payload: { vpn_user_id: vpnAccount.vpn_user_id },
    });
    if (jobError) throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.rotate_credentials",
      targetType: "vpn_account",
      targetId: vpnAccount.id,
      metadata: { user_id: userId, node_id: vpnAccount.node_id },
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("admin/customers/:id/rotate-credentials: failed:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
