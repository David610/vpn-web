import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../../../lib/node-auth.js";
import { sendFailureAlert } from "../../../../lib/resend.js";

export async function onRequestPost({ env, request, params }) {
  const jobId = params.id;
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

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const errorMessage = typeof body.error === "string" ? body.error : "Unknown error";

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, payload, node_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) {
      console.error("agent/fail: job lookup failed:", jobError.message);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!job || job.node_id !== nodeId) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from("provisioning_jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        result: { error: errorMessage },
      })
      .eq("id", jobId);
    if (updateError) throw new Error(`provisioning_jobs update failed: ${updateError.message}`);

    await sendFailureAlert(env, {
      jobId,
      jobType: job.job_type,
      userId: job.payload?.user_id ?? null,
      error: errorMessage,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`agent/fail: failed for job ${jobId}:`, err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
