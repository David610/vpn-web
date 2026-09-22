import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  supabaseAdmin
    .from("nodes")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("node_id", nodeId)
    .then(
      ({ error }) => {
        if (error) console.error("claim: last_seen_at update failed:", error.message);
      },
      (err) => {
        console.error("claim: last_seen_at update failed:", err.message);
      }
    );

  try {
    const { data, error } = await supabaseAdmin.rpc("claim_next_job", { p_node_id: nodeId });
    if (error) {
      console.error("agent/claim: rpc failed:", error.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const job = data?.[0] ?? null;
    return new Response(
      JSON.stringify({
        job: job ? { id: job.id, job_type: job.job_type, payload: job.payload } : null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("agent/claim: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
