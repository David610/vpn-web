import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson, mapOperation, OPERATION_COLUMNS, STEP_COLUMNS } from "../../../lib/admin-fleet.js";

const STATUSES = new Set(["PENDING", "RUNNING", "COMPLETED", "PARTIAL_FAILURE", "ROLLING_BACK", "FAILED"]);

/** Recent fleet operations (sagas) with their steps. ?status=&limit= */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  try {
    let query = supabase.from("fleet_operations").select(OPERATION_COLUMNS).order("created_at", { ascending: false }).limit(limit);
    if (status && STATUSES.has(status)) query = query.eq("status", status);
    const { data: ops, error } = await query;
    if (error) throw new Error(error.message);
    const ids = (ops ?? []).map((o) => o.id);
    let steps = [];
    if (ids.length) {
      const res = await supabase.from("operation_steps").select(STEP_COLUMNS).in("operation_id", ids);
      if (res.error) throw new Error(res.error.message);
      steps = res.data ?? [];
    }
    return fleetJson({ operations: (ops ?? []).map((o) => mapOperation(o, steps)) });
  } catch (err) {
    console.error("admin/fleet/operations:", err.message);
    return fleetJson({ error: "Internal error" }, 500);
  }
}
