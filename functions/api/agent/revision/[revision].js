import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../lib/node-auth.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The agent's APPLY_NODE_REVISION job payload only ever carries a revision
 * number (functions/lib/node-revisions.js) -- this is the separate,
 * authenticated fetch for the actual config content, the same "job says
 * what to do, a fetch supplies the content" split every other job type
 * already uses (e.g. the agent already fetches its own credentials
 * separately rather than having them inlined in a job payload).
 */
export async function onRequestGet({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  // Plain decimal digits only -- Number()'s coercion also accepts things
  // like "3e2" or "0x3", which would look like a safe integer to
  // Number.isSafeInteger() while not being the plain revision number a
  // caller intended.
  if (!/^[1-9][0-9]*$/.test(params.revision ?? "")) {
    return json({ error: "revision must be a positive integer" }, 400);
  }
  const revision = Number(params.revision);
  if (!Number.isSafeInteger(revision)) {
    return json({ error: "revision must be a positive integer" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("node_revisions")
    .select("revision, config")
    // Scoped to the authenticated node's own id -- a node must never be
    // able to fetch another node's desired config by guessing a revision
    // number, even though revision numbers aren't secret.
    .eq("node_id", nodeId)
    .eq("revision", revision)
    .maybeSingle();
  if (error) {
    console.error("agent/revision: lookup failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }
  if (!data) return json({ error: "Revision not found" }, 404);

  return json({ revision: data.revision, config: data.config });
}
