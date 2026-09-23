import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../lib/admin-audit.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPatch({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") return json({ error: "Read-only admins cannot resolve alerts." }, 403);

  if (!/^\d+$/.test(params.id)) {
    return json({ error: "Derived alerts resolve automatically when the condition clears." }, 409);
  }

  try {
    const resolvedAt = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("operational_alerts")
      .update({ status: "resolved", resolved_at: resolvedAt })
      .eq("id", Number(params.id))
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return json({ error: "Alert not found." }, 404);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.resolve_alert",
      targetType: "operational_alert",
      targetId: params.id,
      metadata: {},
    });
    return json({ ok: true });
  } catch (err) {
    console.error("admin/alerts/:id: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
