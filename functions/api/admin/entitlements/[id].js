import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../lib/admin-audit.js";
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
    const { data: grant, error: lookupError } = await supabaseAdmin
      .from("admin_entitlements")
      .select("id, account_id, status")
      .eq("id", params.id)
      .maybeSingle();
    if (lookupError) throw new Error(`grant lookup failed: ${lookupError.message}`);
    if (!grant) return json({ error: "Grant not found." }, 404);
    if (grant.status === "revoked") return json({ ok: true, duplicate: true });

    const revokedAt = new Date().toISOString();
    const { error: revokeError } = await supabaseAdmin
      .from("admin_entitlements")
      .update({ status: "revoked", revoked_at: revokedAt })
      .eq("id", grant.id);
    if (revokeError) throw new Error(`grant revoke failed: ${revokeError.message}`);

    const entitlement = await getEffectiveEntitlement(supabaseAdmin, grant.account_id);
    await syncAccountProvisioningToEntitlement(
      supabaseAdmin,
      grant.account_id,
      entitlement,
      `admin-revoke:${grant.id}`
    );

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.revoke_entitlement",
      targetType: "customer_account",
      targetId: grant.account_id,
      metadata: { grant_id: grant.id },
    });

    return json({ ok: true });
  } catch (err) {
    console.error("admin/entitlements/:id: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
