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
  if (admin.role === "readonly") return json({ error: "Read-only admins cannot review signals." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!["reviewed", "ignored"].includes(body?.status)) {
    return json({ error: "status must be reviewed or ignored" }, 400);
  }

  try {
    const reviewedAt = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("abuse_signals")
      .update({
        review_status: body.status,
        reviewed_at: reviewedAt,
        reviewed_by: admin.userId,
      })
      .eq("id", Number(params.id))
      .select("id, vpn_account_id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return json({ error: "Signal not found." }, 404);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: `admin.abuse_${body.status}`,
      targetType: "vpn_account",
      targetId: String(data.vpn_account_id),
      metadata: { signal_id: data.id },
    });

    return json({ ok: true });
  } catch (err) {
    console.error("admin/abuse/:id: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
