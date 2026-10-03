import { HEARTBEAT_INTERVAL_MS, SILENCE_THRESHOLD_MULTIPLIER } from "./node-health-transition.js";

export const NODE_CAPABILITY_CONTRACT = "arcana.node.capabilities.v1";
export const PROVISIONING_PROTOCOL_VERSION = 2;
export const CLAIM_TOKEN_CAPABILITY_VERSION = 1;
export const AUTHORIZATION_SNAPSHOT_VERSION = 2;

// This is the union of states that can still poll provisioning work or carry
// traffic. Intentionally-offline/security/terminal states are excluded.
export const CLAIM_TOKEN_FLEET_STATES = Object.freeze([
  "PROVISIONING", "WARMING_UP", "CANARY", "READY", "DEGRADED", "DRAINING",
]);
export function isClaimTokenFleetState(state) {
  return CLAIM_TOKEN_FLEET_STATES.includes(state);
}

const uint = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
export function normalizeNodeCapabilities(body) {
  const present = ["capability_contract", "provisioning_protocol", "capabilities"].some((k) =>
    Object.prototype.hasOwnProperty.call(body, k)
  );
  if (!present) return { kind: "absent" };
  const claim = body.capabilities?.claim_token;
  const snapshot = body.capabilities?.external_authorization_snapshot;
  if (
    typeof body.capability_contract !== "string" || body.capability_contract.length < 1 ||
    body.capability_contract.length > 128 || !uint(body.provisioning_protocol, 65535) ||
    !claim || typeof claim !== "object" || !uint(claim.version, 65535) ||
    !uint(claim.minimum_lease_seconds, 86400) || !snapshot || typeof snapshot !== "object" ||
    !uint(snapshot.version, 65535)
  ) return { kind: "malformed", error: "invalid bounded capability fields" };
  return {
    kind: "valid",
    values: {
      capability_contract: body.capability_contract,
      provisioning_protocol: body.provisioning_protocol,
      claim_token_version: claim.version,
      claim_token_minimum_lease_seconds: claim.minimum_lease_seconds,
      external_authorization_snapshot_version: snapshot.version,
    },
  };
}

export function capabilityReasons(node, nowMs = Date.now(), serverLeaseSeconds) {
  if (!Number.isSafeInteger(serverLeaseSeconds) || serverLeaseSeconds <= 0)
    throw new Error("canonical server claim lease is required");
  if (!node.capabilities_reported_at) return ["no capability heartbeat"];
  const seen = Date.parse(node.capabilities_reported_at);
  if (!Number.isFinite(seen) || nowMs - seen > HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER)
    return ["stale heartbeat"];
  const reasons = [];
  if (node.capability_contract !== NODE_CAPABILITY_CONTRACT) reasons.push("wrong capability contract");
  if (node.provisioning_protocol < PROVISIONING_PROTOCOL_VERSION) reasons.push("old provisioning protocol");
  if (node.claim_token_version !== CLAIM_TOKEN_CAPABILITY_VERSION) reasons.push("claim-token version unsupported");
  if (node.claim_token_minimum_lease_seconds > serverLeaseSeconds)
    reasons.push("node requires lease longer than server provides");
  if (node.external_authorization_snapshot_version !== AUTHORIZATION_SNAPSHOT_VERSION)
    reasons.push("external authorization snapshot version incompatible");
  return reasons;
}

export async function fleetClaimTokenReadiness(supabase, { nowMs = Date.now() } = {}) {
  const [{ data, error }, { data: leaseSeconds, error: leaseError }] = await Promise.all([
    supabase.from("nodes").select(
    "node_id,agent_version,lifecycle_state,capability_contract,provisioning_protocol,claim_token_version,claim_token_minimum_lease_seconds,external_authorization_snapshot_version,capabilities_reported_at"
    ).in("lifecycle_state", CLAIM_TOKEN_FLEET_STATES),
    supabase.rpc("claim_token_lease_seconds"),
  ]);
  if (error) throw new Error(`fleet capability query failed: ${error.message}`);
  if (leaseError || !Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0)
    throw new Error(`claim lease contract query failed: ${leaseError?.message ?? "invalid value"}`);
  const nodes = (data ?? []).map((node) => ({ ...node, reasons: capabilityReasons(node, nowMs, leaseSeconds) }));
  const incompatible = nodes.filter((n) => n.reasons.length).map((n) => ({
    node_id: n.node_id, agent_version: n.agent_version, provisioning_protocol: n.provisioning_protocol,
    claim_token_version: n.claim_token_version,
    minimum_lease_seconds: n.claim_token_minimum_lease_seconds,
    capabilities_reported_at: n.capabilities_reported_at, reasons: n.reasons,
  }));
  return {
    ready: nodes.length > 0 && incompatible.length === 0,
    required_contract: NODE_CAPABILITY_CONTRACT,
    required_provisioning_protocol: PROVISIONING_PROTOCOL_VERSION,
    required_claim_token_version: CLAIM_TOKEN_CAPABILITY_VERSION,
    required_external_authorization_snapshot_version: AUTHORIZATION_SNAPSHOT_VERSION,
    server_claim_lease_seconds: leaseSeconds,
    eligible_nodes: nodes.length,
    compatible_nodes: nodes.length - incompatible.length,
    eligible_node_ids: nodes.map((n) => n.node_id),
    eligible_node_versions: nodes.map((n) => ({ node_id: n.node_id, agent_version: n.agent_version ?? null })),
    incompatible_nodes: incompatible,
  };
}
