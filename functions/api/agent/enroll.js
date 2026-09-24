import { createClient } from "@supabase/supabase-js";
import { sha256Hex } from "../../lib/crypto.js";
import { generateHexSecret } from "../../lib/node-enrollment.js";
import { canTransitionLifecycle } from "../../lib/node-lifecycle.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A fresh VPS's first (and only) unauthenticated-by-api-key call: trades
 * a short-lived enrollment token (minted by POST /api/admin/nodes, never
 * seen by this endpoint's caller before now) for the node's permanent
 * API key. From here on the agent authenticates every other request via
 * functions/lib/node-auth.js like any enrolled node.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authHeader = request.headers.get("Authorization");
  const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawToken) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const tokenHash = await sha256Hex(rawToken);
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state, enrollment_token_expires_at")
      .eq("enrollment_token_hash", tokenHash)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Unauthorized" }, 401);
    if (!node.enrollment_token_expires_at || new Date(node.enrollment_token_expires_at) < new Date()) {
      return jsonResponse({ error: "Enrollment token expired" }, 401);
    }
    if (!canTransitionLifecycle(node.lifecycle_state, "WARMING_UP")) {
      // Defense in depth: the token is cleared atomically with this same
      // transition below, so this should be unreachable in practice, but
      // a node that somehow isn't PROVISIONING must never re-enroll.
      return jsonResponse({ error: "Node is not awaiting enrollment" }, 409);
    }

    const rawApiKey = generateHexSecret();
    const apiKeyHash = await sha256Hex(rawApiKey);

    // Guarded on enrollment_token_hash AND lifecycle_state still matching
    // what this request read, not just node_id. The token-hash guard
    // alone stops a duplicated token from being consumed twice, but the
    // admin lifecycle endpoint (functions/api/admin/nodes/[id]/lifecycle.js)
    // never touches enrollment_token_hash — so without the lifecycle_state
    // guard too, an admin quarantining this node between our SELECT and
    // this UPDATE would be silently overwritten back to WARMING_UP with a
    // freshly issued API key, undoing a security containment action that
    // is supposed to be one-way (node-lifecycle.js).
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("nodes")
      .update({
        api_key_hash: apiKeyHash,
        enrollment_token_hash: null,
        enrollment_token_expires_at: null,
        lifecycle_state: "WARMING_UP",
      })
      .eq("node_id", node.node_id)
      .eq("enrollment_token_hash", tokenHash)
      .eq("lifecycle_state", node.lifecycle_state)
      .select("node_id")
      .maybeSingle();
    if (updateError) throw new Error(`nodes update failed: ${updateError.message}`);
    if (!updated) return jsonResponse({ error: "Enrollment token already used" }, 409);

    return jsonResponse({ nodeId: node.node_id, apiKey: rawApiKey });
  } catch (err) {
    console.error("agent/enroll: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
