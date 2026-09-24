import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { createNodeRevision } from "../../../../lib/node-revisions.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Manually pushes a new desired-state config revision for a node (spec 54
 * Phase 6). This is the admin-facing entry point into
 * functions/lib/node-revisions.js -- later phases (8 health/failover, 12
 * replace-node) will call createNodeRevision() from their own automated
 * triggers, but a human-initiated push is the first real caller and the
 * one this phase's own tests exercise end to end.
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

  const nodeId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (body == null || typeof body.config !== "object" || body.config === null) {
    return jsonResponse({ error: "config must be a JSON object" }, 400);
  }
  const reason = typeof body?.reason === "string" && body.reason ? body.reason : null;

  try {
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Node not found" }, 404);

    const { revision } = await createNodeRevision(supabaseAdmin, {
      nodeId,
      config: body.config,
      reason,
      createdBy: admin.userId,
    });

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.push_node_revision",
      targetType: "node",
      targetId: nodeId,
      metadata: { revision, reason },
    });

    return jsonResponse({ ok: true, revision }, 201);
  } catch (err) {
    console.error("admin/nodes/:id/revisions: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
