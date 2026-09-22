import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// v1 retry: inserts a brand-new job copying the failed job's shape.
// Deliberately does NOT flip the original row back to "pending" (that
// would lose history and could incorrectly replay a job whose side
// effect already partially happened) and does NOT add a parent_job_id
// column yet (see docs/superpowers/plans/2026-09-22-admin-dashboard.md
// Open Items) — the admin_audit_log row's metadata.original_job_id is
// enough lineage for v1.
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  const jobId = params.id;

  try {
    const { data: job, error: jobError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, status, node_id, vpn_account_id, payload")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) throw new Error(`provisioning_jobs lookup failed: ${jobError.message}`);
    if (!job) return jsonResponse({ error: "Job not found" }, 404);
    if (job.status !== "failed") return jsonResponse({ error: "Only failed jobs can be retried" }, 400);

    const idempotencyKey = `admin-retry:${job.id}:${Date.now()}`;
    const { error: insertError } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: idempotencyKey,
      node_id: job.node_id,
      job_type: job.job_type,
      vpn_account_id: job.vpn_account_id,
      payload: job.payload,
    });
    if (insertError) throw new Error(`provisioning_jobs insert failed: ${insertError.message}`);

    // id is a DB-generated identity column, so fetch the row we just
    // inserted back by its unique idempotency_key.
    const { data: newJob, error: fetchError } = await supabaseAdmin
      .from("provisioning_jobs")
      .select("id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (fetchError) throw new Error(`provisioning_jobs re-fetch failed: ${fetchError.message}`);

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.retry_job",
      targetType: "provisioning_job",
      targetId: newJob?.id,
      metadata: { original_job_id: job.id },
    });

    return jsonResponse({ ok: true, jobId: newJob?.id });
  } catch (err) {
    console.error("admin/jobs/:id/retry: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
