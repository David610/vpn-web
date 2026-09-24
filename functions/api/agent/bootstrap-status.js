import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { BOOTSTRAP_STAGES } from "../../lib/node-bootstrap.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const STATUSES = new Set(["RUNNING", "OK", "FAILED"]);

/**
 * Progress report from a node's bootstrap script (functions/lib/
 * node-bootstrap.js), authenticated with the node's own permanent key --
 * so only stages after ENROLL are ever reported. Feeds the CREATE_NODE
 * operation's AWAIT_BOOTSTRAP step and the admin fleet view.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!BOOTSTRAP_STAGES.includes(body?.stage) || !STATUSES.has(body?.status)) {
    return json({ error: "stage/status invalid" }, 400);
  }
  // Same character whitelist the script applies; enforced again here since
  // this lands in an admin UI.
  const message =
    typeof body.message === "string"
      ? body.message.replace(/[^A-Za-z0-9 _.,:/()=+-]/g, "").slice(0, 400)
      : null;

  const { error } = await supabaseAdmin
    .from("nodes")
    .update({
      bootstrap_stage: body.stage,
      bootstrap_status: body.status,
      bootstrap_message: message,
      bootstrap_updated_at: new Date().toISOString(),
    })
    .eq("node_id", nodeId);
  if (error) {
    console.error("agent/bootstrap-status: update failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }
  return json({ ok: true });
}
