import { sha256Hex } from "./crypto.js";

// Optional per-process cache, enabled only by the long-lived Node API server
// (see server/index.mjs). Pages Functions never call configureNodeAuthCache,
// so their behaviour is unchanged. A node that is revoked or quarantined is
// rejected no later than ttlMs after the change, or immediately through
// invalidateNodeAuth. Lookup errors are never cached.
let cache = null;

export function configureNodeAuthCache(options) {
  if (!options) { cache = null; return; }
  cache = {
    ttlMs: options.ttlMs ?? 5_000,
    negativeTtlMs: options.negativeTtlMs ?? 1_000,
    maxEntries: options.maxEntries ?? 1_024,
    now: options.now ?? Date.now,
    entries: new Map(),
  };
}

export function invalidateNodeAuth(nodeId) {
  if (!cache) return;
  for (const [key, entry] of cache.entries) if (!nodeId || entry.nodeId === nodeId) cache.entries.delete(key);
}

function remember(keyHash, nodeId) {
  if (!cache) return;
  if (cache.entries.size >= cache.maxEntries) cache.entries.delete(cache.entries.keys().next().value);
  const ttl = nodeId ? cache.ttlMs : cache.negativeTtlMs;
  cache.entries.set(keyHash, { nodeId, expiresAt: cache.now() + ttl });
}

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
  const hit = cache?.entries.get(keyHash);
  if (hit && hit.expiresAt > cache.now()) return hit.nodeId;
  const { data, error } = await supabaseAdmin
    .from("nodes")
    .select("node_id, revoked_at, lifecycle_state")
    .eq("api_key_hash", keyHash)
    .maybeSingle();
  if (error) {
    console.error("authenticateNode: lookup failed:", error.message);
    return null;
  }
  if (!data || data.revoked_at) { remember(keyHash, null); return null; }
  // F-05: QUARANTINED/RETIRED must reject even in the (should-be-impossible,
  // but defense in depth) case api_key_hash/revoked_at were not cleared —
  // e.g. a row created before this fix, or a future code path that
  // transitions lifecycle without going through revokeNodeKeyAndTransition.
  // Every /api/agent/* handler funnels through this function, so this one
  // check is what the enumerated-route regression test in
  // node-auth.test.js exercises against each of them.
  if (data.lifecycle_state === "QUARANTINED" || data.lifecycle_state === "RETIRED") { remember(keyHash, null); return null; }
  remember(keyHash, data.node_id);
  return data.node_id;
}
