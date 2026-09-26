import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson } from "../../../lib/admin-fleet.js";

/**
 * Locations and allowed logical routes (allowed_paths), with per-location
 * node counts by lifecycle state. Read-only.
 */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  try {
    const [locs, paths, nodes] = await Promise.all([
      supabase.from("locations").select("id, country_code, city, display_name, enabled, created_at"),
      supabase.from("allowed_paths").select("id, entry_location_id, exit_location_id, enabled, required_entitlement, created_at"),
      supabase.from("nodes").select("node_id, location_id, role, lifecycle_state"),
    ]);
    for (const r of [locs, paths, nodes]) if (r.error) throw new Error(r.error.message);

    const byId = new Map((locs.data ?? []).map((l) => [l.id, l]));
    const label = (id) => (id && byId.get(id) ? byId.get(id).display_name : null);
    const locations = (locs.data ?? []).map((l) => {
      const here = (nodes.data ?? []).filter((n) => n.location_id === l.id);
      const states = {};
      for (const n of here) states[n.lifecycle_state] = (states[n.lifecycle_state] ?? 0) + 1;
      return {
        id: l.id,
        countryCode: l.country_code,
        city: l.city ?? null,
        displayName: l.display_name,
        enabled: l.enabled,
        nodes: here.length,
        exitNodes: here.filter((n) => n.role === "EXIT").length,
        relayNodes: here.filter((n) => n.role === "RELAY").length,
        readyNodes: states.READY ?? 0,
        states,
      };
    });
    const allowedPaths = (paths.data ?? []).map((p) => ({
      id: p.id,
      kind: p.entry_location_id ? "DOUBLE_HOP" : "DIRECT",
      entryLocationId: p.entry_location_id ?? null,
      entry: label(p.entry_location_id),
      exitLocationId: p.exit_location_id,
      exit: label(p.exit_location_id),
      enabled: p.enabled,
      requiredEntitlement: p.required_entitlement ?? null,
      createdAt: p.created_at,
    }));
    return fleetJson({ locations, allowedPaths });
  } catch (err) {
    console.error("admin/fleet/topology:", err.message);
    return fleetJson({ error: "Internal error" }, 500);
  }
}
