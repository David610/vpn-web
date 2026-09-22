import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../lib/admin-sanitize.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = supabaseAdmin
      .from("provisioning_jobs")
      .select("id, job_type, status, node_id, vpn_account_id, created_at, claimed_at, completed_at, result")
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new Error(`provisioning_jobs query failed: ${error.message}`);

    const jobs = data.map((j) => ({
      id: j.id,
      jobType: j.job_type,
      status: j.status,
      nodeId: j.node_id,
      vpnAccountId: j.vpn_account_id,
      createdAt: j.created_at,
      claimedAt: j.claimed_at,
      completedAt: j.completed_at,
      result: sanitizeJobResult(j.result),
    }));

    return jsonResponse({ jobs });
  } catch (err) {
    console.error("admin/jobs: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
