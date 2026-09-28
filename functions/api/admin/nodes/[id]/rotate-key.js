import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { sha256Hex } from "../../../../lib/crypto.js";
import { generateHexSecret } from "../../../../lib/node-enrollment.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * F-05/C-09: admin "rotate node key" action. Distinct from the QUARANTINED/
 * RETIRED lifecycle transition (lifecycle.js's revoke_node_key_and_transition
 * RPC): this is for a suspected-leaked key on a node that should keep
 * serving traffic (still READY/DEGRADED/etc). The old key stops working the
 * instant this commits; the new plaintext key is returned exactly once,
 * same discipline as enrollment tokens (node-enrollment.js) and invite
 * tokens (invite-token.js) -- only the hash is ever persisted.
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

  try {
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Node not found" }, 404);
    if (node.lifecycle_state === "QUARANTINED" || node.lifecycle_state === "RETIRED") {
      return jsonResponse(
        { error: "Node is QUARANTINED/RETIRED — its key is already revoked, not rotated" },
        409
      );
    }

    const newKey = generateHexSecret();
    const newKeyHash = await sha256Hex(newKey);

    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc("rotate_node_key", {
      p_node_id: nodeId,
      p_new_key_hash: newKeyHash,
    });
    if (rpcError) throw new Error(`rotate_node_key failed: ${rpcError.message}`);
    if (rpcResult?.status === "not_found") return jsonResponse({ error: "Node not found" }, 404);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.node_key_rotated",
      targetType: "node",
      targetId: nodeId,
      // Never the key or its hash, same discipline as everywhere else in
      // this file's neighbors.
      metadata: {},
    });

    return jsonResponse({ ok: true, apiKey: newKey });
  } catch (err) {
    console.error("admin/nodes/:id/rotate-key: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
