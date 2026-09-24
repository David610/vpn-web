import { createClient } from "@supabase/supabase-js";
import { sha256Hex } from "../../lib/crypto.js";
import { canTransitionLifecycle } from "../../lib/node-lifecycle.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A fresh VPS's first (and only) unauthenticated-by-api-key call: binds a
 * short-lived enrollment token (minted by POST /api/admin/nodes) to the
 * node's permanent API key.
 *
 * The node generates that key itself and persists it to disk BEFORE calling
 * this endpoint, then sends only its SHA-256 (`apiKeySha256`). The raw key
 * therefore never crosses the network and never exists anywhere but the VPS,
 * and there is no crash window in which the control plane has accepted a key
 * the node has not yet saved -- the failure mode of the previous design,
 * where this endpoint minted the key and a crash before the response was
 * written to disk left the node enrolled with a key nobody held.
 *
 * Retry semantics (a timeout, a crash after the UPDATE but before the node
 * saw the 200):
 *   - same token + same key hash, node already WARMING_UP  -> 200 (idempotent)
 *   - same token + a DIFFERENT key hash after redemption   -> 409
 * so one token can bind exactly one key, never mint an unlimited number.
 * The token hash is kept (not cleared) after redemption precisely so the
 * idempotent retry can find the row; it still expires on its normal TTL and
 * is cleared on the node's first authenticated heartbeat.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authHeader = request.headers.get("Authorization");
  const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawToken) return jsonResponse({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const apiKeySha256 = typeof body?.apiKeySha256 === "string" ? body.apiKeySha256 : "";
  if (!SHA256_HEX.test(apiKeySha256)) {
    return jsonResponse({ error: "apiKeySha256 must be a lowercase hex SHA-256" }, 400);
  }
  const claimedNodeId = typeof body?.nodeId === "string" ? body.nodeId : null;

  try {
    const tokenHash = await sha256Hex(rawToken);
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state, enrollment_token_expires_at, api_key_hash")
      .eq("enrollment_token_hash", tokenHash)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Unauthorized" }, 401);
    // A bootstrap file names the node it was written for; a token presented
    // on behalf of a different node is a misconfiguration (or a replayed
    // token) and must never bind a key to the wrong row.
    if (claimedNodeId !== null && claimedNodeId !== node.node_id) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    if (!node.enrollment_token_expires_at || new Date(node.enrollment_token_expires_at) < new Date()) {
      return jsonResponse({ error: "Enrollment token expired" }, 401);
    }

    // Idempotent retry of a redemption that already landed.
    if (node.lifecycle_state === "WARMING_UP" && node.api_key_hash) {
      if (node.api_key_hash === apiKeySha256) {
        return jsonResponse({ nodeId: node.node_id, alreadyEnrolled: true });
      }
      return jsonResponse({ error: "Enrollment token already used" }, 409);
    }

    if (!canTransitionLifecycle(node.lifecycle_state, "WARMING_UP")) {
      return jsonResponse({ error: "Node is not awaiting enrollment" }, 409);
    }

    // Guarded on enrollment_token_hash AND lifecycle_state still matching
    // what this request read. The token-hash guard alone stops a concurrent
    // redemption of the same token binding a second key, but the admin
    // lifecycle endpoint (functions/api/admin/nodes/[id]/lifecycle.js) never
    // touches enrollment_token_hash — so without the lifecycle_state guard
    // too, an admin quarantining this node between our SELECT and this
    // UPDATE would be silently overwritten back to WARMING_UP, undoing a
    // security containment action that is supposed to be one-way.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("nodes")
      .update({
        api_key_hash: apiKeySha256,
        lifecycle_state: "WARMING_UP",
      })
      .eq("node_id", node.node_id)
      .eq("enrollment_token_hash", tokenHash)
      .eq("lifecycle_state", node.lifecycle_state)
      // Re-check expiry at write time, not just at the SELECT above.
      .gt("enrollment_token_expires_at", new Date().toISOString())
      .select("node_id")
      .maybeSingle();
    if (updateError) {
      // api_key_hash is unique: a collision means this exact key is already
      // bound to some other node. Never reveal which.
      if (updateError.code === "23505") return jsonResponse({ error: "Key rejected" }, 409);
      throw new Error(`nodes update failed: ${updateError.message}`);
    }
    if (!updated) return jsonResponse({ error: "Enrollment token already used" }, 409);

    return jsonResponse({ nodeId: node.node_id, alreadyEnrolled: false });
  } catch (err) {
    console.error("agent/enroll: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
