import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson, configPresence } from "../../../lib/admin-fleet.js";

const FLEET_GROUPS = new Set(["Fleet provisioning", "Route signing", "Fleet automation flags"]);

/**
 * Feature flags and fleet readiness: presence (never values) of the fleet
 * variables, flag on/off, and an overall "can provision" verdict.
 */
export async function onRequestGet({ env, request }) {
  const { admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  const variables = configPresence(env).filter((v) => FLEET_GROUPS.has(v.group));
  const missing = variables.filter((v) => v.required && !v.present).map((v) => v.name);
  return fleetJson({
    flags: variables.filter((v) => v.enabled !== undefined).map((v) => ({ name: v.name, enabled: v.enabled, purpose: v.purpose })),
    variables,
    provisioningReady: missing.length === 0,
    missing,
  });
}
