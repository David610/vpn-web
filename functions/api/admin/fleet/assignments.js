import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson } from "../../../lib/admin-fleet.js";

const UUIDISH = /^[0-9a-f-]{4,36}$/i;
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Device -> node placements (device_node_assignments). Returns a per-node
 * aggregate (always) plus a page of individual rows filtered by ?nodeId=,
 * ?hop= or ?q= (device/account id prefix). Rows carry ids, platform and
 * status only -- no device names, emails or credentials.
 */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  const url = new URL(request.url);
  const nodeId = url.searchParams.get("nodeId");
  const hop = url.searchParams.get("hop");
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  try {
    const { data: all, error: aggError } = await supabase.from("device_node_assignments").select("node_id, hop");
    if (aggError) throw new Error(aggError.message);
    const agg = new Map();
    for (const row of all ?? []) {
      const a = agg.get(row.node_id) ?? { nodeId: row.node_id, exit: 0, relay: 0, total: 0 };
      if (row.hop === "RELAY") a.relay += 1;
      else a.exit += 1;
      a.total += 1;
      agg.set(row.node_id, a);
    }

    let query = supabase
      .from("device_node_assignments")
      .select("device_id, node_id, hop, assigned_at, devices(account_id, platform, status, placement_status, subscription_id)")
      .order("assigned_at", { ascending: false })
      .limit(limit);
    if (nodeId && NODE_ID.test(nodeId)) query = query.eq("node_id", nodeId);
    if (hop === "EXIT" || hop === "RELAY") query = query.eq("hop", hop);
    // A full UUID is matched server-side against device id OR account id,
    // so a search is not limited to the newest page of rows.
    if (FULL_UUID.test(q)) {
      const { data: devs, error: devError } = await supabase
        .from("devices")
        .select("id")
        .or(`id.eq.${q.toLowerCase()},account_id.eq.${q.toLowerCase()}`)
        .limit(500);
      if (devError) throw new Error(devError.message);
      const ids = (devs ?? []).map((d) => d.id);
      if (!ids.length) {
        return fleetJson({ byNode: [...agg.values()].sort((a, b) => b.total - a.total), total: (all ?? []).length, assignments: [], limit });
      }
      query = query.in("device_id", ids);
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    const needle = UUIDISH.test(q) ? q.toLowerCase() : null;
    const assignments = (rows ?? [])
      .map((r) => ({
        deviceId: r.device_id,
        nodeId: r.node_id,
        hop: r.hop,
        assignedAt: r.assigned_at,
        accountId: r.devices?.account_id ?? null,
        subscriptionId: r.devices?.subscription_id ?? null,
        platform: r.devices?.platform ?? null,
        deviceStatus: r.devices?.status ?? null,
        placementStatus: r.devices?.placement_status ?? null,
      }))
      .filter((a) => !needle || a.deviceId.startsWith(needle) || (a.accountId ?? "").startsWith(needle) || a.nodeId.includes(needle));

    return fleetJson({
      byNode: [...agg.values()].sort((a, b) => b.total - a.total),
      total: (all ?? []).length,
      assignments,
      limit,
    });
  } catch (err) {
    console.error("admin/fleet/assignments:", err.message);
    return fleetJson({ error: "Internal error" }, 500);
  }
}
