import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";
import { sanitizeJobResult } from "../../lib/admin-sanitize.js";

const VALID_STATUSES = new Set(["pending", "claimed", "done", "failed"]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function boundedInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status")?.trim() ?? "";
    if (status && !VALID_STATUSES.has(status)) {
      return jsonResponse({ error: "Invalid status filter" }, 400);
    }

    const page = boundedInt(url.searchParams.get("page"), 1, 1, 1_000_000);
    const perPage = boundedInt(url.searchParams.get("per_page"), 50, 10, 100);
    const offset = (page - 1) * perPage;

    let query = supabaseAdmin
      .from("provisioning_jobs")
      .select(
        "id, job_type, status, node_id, vpn_account_id, created_at, claimed_at, completed_at, result",
        { count: "exact" }
      )
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { data, count, error } = await query.range(offset, offset + perPage - 1);
    if (error) throw new Error(`provisioning_jobs query failed: ${error.message}`);

    const jobs = (data ?? []).map((j) => ({
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

    const total = count ?? 0;
    return jsonResponse({
      jobs,
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error("admin/jobs: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
