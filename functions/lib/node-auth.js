import { sha256Hex } from "./crypto.js";

/**
 * Authenticates a provisioning-agent request via its per-node shared
 * secret (never a Supabase session — the agent has no Supabase
 * credential, per the design's "no inbound admin surface added to the
 * VPS" property applying in reverse: the Worker API is the only thing
 * the agent trusts, and it authenticates with a secret scoped to itself).
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @returns {Promise<string | null>} the authenticated node_id, or null if
 *   the request has no/invalid/revoked credentials.
 */
export async function authenticateNode(request, supabaseAdmin) {
  const authHeader = request.headers.get("Authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!rawKey) return null;

  const keyHash = await sha256Hex(rawKey);
  const { data, error } = await supabaseAdmin
    .from("nodes")
    .select("node_id, revoked_at")
    .eq("api_key_hash", keyHash)
    .maybeSingle();
  if (error) {
    console.error("authenticateNode: lookup failed:", error.message);
    return null;
  }
  if (!data || data.revoked_at) return null;
  return data.node_id;
}
