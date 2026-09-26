import { selectNodeForDevice, isUnderCapacity } from "./scheduler.js";

const HAS_TRANSPORT = (node) => typeof node.transport === "string" && node.transport.length > 0;

// scheduler.js's own DB-facing callers already filter to READY/CANARY at
// the query level (`.in("lifecycle_state", ["READY", "CANARY"])`) before
// isUnderCapacity ever runs -- isUnderCapacity itself does not reject a
// FAILED/QUARANTINED node. This function is reused here with data this
// caller does not fully control the query shape of, and the cost of a
// stale/compromised node's real REALITY key ending up in a signed public
// route is high enough to filter explicitly here too, not just trust the
// caller (defense in depth, same reasoning as canTransitionLifecycle
// being re-checked at every write site even though callers already
// checked once).
const ELIGIBLE_LIFECYCLE_STATES = new Set(["READY", "CANARY"]);

function toHop(node) {
  const hop = {
    transport: node.transport,
    server_address: node.hostname,
    server_port: node.transportPort,
    tls_server_name: node.tlsServerName,
  };
  if (node.transport === "vless-reality") {
    hop.reality_public_key = node.realityPublicKey;
    hop.reality_short_id = node.realityShortId;
    hop.reality_fingerprint = node.realityFingerprint;
    hop.vless_flow = node.vlessFlow;
  } else if (node.hysteria2ObfsType) {
    hop.hysteria2_obfs_type = node.hysteria2ObfsType;
  }
  return hop;
}

function pickNode(candidates) {
  const eligible = candidates.filter(
    (node) => ELIGIBLE_LIFECYCLE_STATES.has(node.lifecycleState) && HAS_TRANSPORT(node) && isUnderCapacity(node)
  );
  const nodeId = selectNodeForDevice({ candidates: eligible, stickyNodeId: null });
  return eligible.find((node) => node.nodeId === nodeId) ?? null;
}

/**
 * Pure route-directory rendering: no I/O, no Supabase client. Reuses
 * scheduler.js's own candidate-selection logic (isUnderCapacity,
 * selectNodeForDevice) to pick, per (location, mode), whichever node the
 * scheduler currently prefers -- without committing anything. A node
 * that has never reported transport params (Task 3) is never a
 * candidate, and a location/pair with no eligible candidate produces no
 * route at all, never a partial one.
 */
export function renderRoutes({ nodes, locations, allowedPaths }) {
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const byLocationAndRole = (locationId, role) =>
    nodes.filter((node) => node.locationId === locationId && node.role === role);

  const routes = [];

  for (const location of locations) {
    const exitNode = pickNode(byLocationAndRole(location.id, "EXIT"));
    if (!exitNode) continue;
    const route = {
      id: `${location.countryCode.toLowerCase()}-fast`,
      label: location.displayName,
      region: location.countryCode,
      mode: "fast",
      priority: 100,
      hops: [toHop(exitNode)],
    };
    if (exitNode.failureDomain) route.failure_domain = exitNode.failureDomain;
    routes.push(route);
  }

  for (const path of allowedPaths) {
    const entryLocation = locationById.get(path.entryLocationId);
    const exitLocation = locationById.get(path.exitLocationId);
    if (!entryLocation || !exitLocation) continue;
    const relayNode = pickNode(byLocationAndRole(path.entryLocationId, "RELAY"));
    const exitNode = pickNode(byLocationAndRole(path.exitLocationId, "EXIT"));
    if (!relayNode || !exitNode) continue;
    const route = {
      id: `${entryLocation.countryCode.toLowerCase()}-${exitLocation.countryCode.toLowerCase()}-privacy`,
      label: `${entryLocation.displayName} → ${exitLocation.displayName} Privacy+`,
      region: exitLocation.countryCode,
      mode: "privacy_plus",
      priority: 100,
      hops: [toHop(relayNode), toHop(exitNode)],
    };
    if (exitNode.failureDomain) route.failure_domain = exitNode.failureDomain;
    routes.push(route);
  }

  return { routes };
}
