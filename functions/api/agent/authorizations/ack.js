import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../lib/node-auth.js";

const ID = /^cred_[A-Za-z0-9_-]{6,91}$/;

export async function onRequestPost({ env, request }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers }); }

  const ids = body?.credential_ids;
  if (!Array.isArray(ids) || ids.length > 4096 ||
      ids.some((id) => typeof id !== "string" || !ID.test(id)) ||
      new Set(ids).size !== ids.length) {
    return new Response(JSON.stringify({ error: "Invalid authorization acknowledgement" }), { status: 400, headers });
  }

  const { data, error } = await db.rpc("ack_compatibility_authorizations", {
    p_node_id: nodeId,
    p_credential_ids: ids,
  });
  if (error) {
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  }
  return new Response(JSON.stringify({
    acknowledged: ids.length,
    published_routes: (data ?? []).map((row) => row.published_route_id),
  }), { status: 200, headers });
}