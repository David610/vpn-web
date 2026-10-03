import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../lib/admin-auth.js";
import { fleetAdminContext, fleetJson, configPresence } from "../../../lib/admin-fleet.js";
import { fleetClaimTokenReadiness } from "../../../lib/node-capabilities.js";

const FLEET_GROUPS = new Set(["Fleet provisioning", "Route signing", "Fleet automation flags"]);

/**
 * Feature flags and fleet readiness: presence (never values) of the fleet
 * variables, flag on/off, and an overall "can provision" verdict.
 */
export async function onRequestGet({ env, request }) {
  const { supabase, admin, response } = await fleetAdminContext(env, request, { createClient, requireAdmin });
  if (!admin) return response;
  const variables = configPresence(env).filter((v) => FLEET_GROUPS.has(v.group));
  const missing = variables.filter((v) => v.required && !v.present).map((v) => v.name);
  let claimToken;
  try {
    claimToken = await fleetClaimTokenReadiness(supabase);
  } catch (error) {
    return fleetJson({ error: error.message }, 500);
  }
  return fleetJson({
    flags: variables.filter((v) => v.enabled !== undefined).map((v) => ({ name: v.name, enabled: v.enabled, purpose: v.purpose })),
    variables,
    provisioningReady: missing.length === 0,
    missing,
    claimEnforcement: {
      ready: claimToken.ready,
      eligibleNodes: claimToken.eligible_nodes,
      compatibleNodes: claimToken.compatible_nodes,
      serverLeaseSeconds: claimToken.server_claim_lease_seconds,
      incompatibleNodes: claimToken.incompatible_nodes.map((node) => ({
        nodeId: node.node_id, reasons: node.reasons, agentVersion: node.agent_version,
        provisioningProtocol: node.provisioning_protocol,
        claimCapabilityVersion: node.claim_token_version,
        minimumLeaseSeconds: node.minimum_lease_seconds,
        capabilitiesReportedAt: node.capabilities_reported_at,
      })),
    },
  });
}
