import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { isValidLifecycleState, canTransitionLifecycle } from "../../../../lib/node-lifecycle.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPatch({ env, request, params }) {
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
  if (!isValidLifecycleState(body?.state)) {
    return jsonResponse({ error: "state must be a valid node lifecycle state" }, 400);
  }

  try {
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Node not found" }, 404);

    if (!canTransitionLifecycle(node.lifecycle_state, body.state)) {
      return jsonResponse(
        { error: `Cannot transition from ${node.lifecycle_state} to ${body.state}` },
        409
      );
    }

    // RETIRED is terminal (see node-lifecycle.js) so retired_at, once set,
    // is a reliable "this node stopped serving traffic at" timestamp —
    // never overwritten by a later transition, since none is possible.
    const update = { lifecycle_state: body.state };
    if (body.state === "RETIRED") update.retired_at = new Date().toISOString();

    // Guard the write on the lifecycle_state this request actually
    // validated against, not just node_id: without it, two concurrent
    // requests both reading READY (one going to QUARANTINED, one to
    // DRAINING) can both pass canTransitionLifecycle and the second
    // UPDATE silently overwrites the first's result — including undoing
    // a just-applied QUARANTINED, which is supposed to be a one-way
    // security containment (spec §45). If zero rows match, someone else's
    // transition landed first; the client should re-read and retry
    // rather than get a false "ok" for a write that never happened.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("nodes")
      .update(update)
      .eq("node_id", nodeId)
      .eq("lifecycle_state", node.lifecycle_state)
      .select("node_id")
      .maybeSingle();
    if (updateError) throw new Error(`nodes update failed: ${updateError.message}`);
    if (!updated) {
      return jsonResponse(
        { error: "Node lifecycle_state changed concurrently — reload and retry" },
        409
      );
    }

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.node_lifecycle_transition",
      targetType: "node",
      targetId: nodeId,
      metadata: { from: node.lifecycle_state, to: body.state },
    });

    return jsonResponse({ ok: true, lifecycleState: body.state });
  } catch (err) {
    console.error("admin/nodes/:id/lifecycle: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
