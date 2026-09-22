import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin
      .from("admin_audit_log")
      .select("id, admin_user_id, action, target_type, target_id, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`admin_audit_log query failed: ${error.message}`);

    const entries = data.map((e) => ({
      id: e.id,
      adminUserId: e.admin_user_id,
      action: e.action,
      targetType: e.target_type,
      targetId: e.target_id,
      metadata: e.metadata,
      createdAt: e.created_at,
    }));

    return jsonResponse({ entries });
  } catch (err) {
    console.error("admin/audit: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
