import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function classify(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 45_000) return "online";
  if (ageMs < 120_000) return "degraded";
  return "offline";
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin.from("nodes").select("node_id, last_seen_at, revoked_at");
    if (error) throw new Error(`nodes query failed: ${error.message}`);

    const nodes = data.map((n) => ({
      nodeId: n.node_id,
      status: n.revoked_at ? "revoked" : classify(n.last_seen_at),
      lastSeenAt: n.last_seen_at,
      revokedAt: n.revoked_at,
    }));

    return jsonResponse({ nodes });
  } catch (err) {
    console.error("admin/nodes: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
