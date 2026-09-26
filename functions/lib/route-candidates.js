import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJsonString } from "./canonical-json.js";
import { isUnderCapacity } from "./scheduler.js";

/**
 * Route candidates: the single source of truth binding signed route
 * metadata to exact physical hops.
 *
 * GET /v1/routes publishes candidates built here; POST /v1/vpn/authorize
 * rebuilds them from current fleet state with the same function and
 * resolves the client's route_id back to the exact node ids it names. It
 * never reschedules: a route id that no longer matches a live candidate
 * (node gone, drained, full, or any published hop metadata changed) is
 * rejected with route_stale and the client refreshes its directory.
 *
 * The id is content-derived: SHA-256 over the mode, the location pair,
 * each hop's node id AND every public field the client will dial with.
 * So signed metadata -> id -> hop node ids is a function, and a client
 * can never be authorized for a node other than the one whose IP/key it
 * holds. Node ids never leave the server (the id is a truncated hash).
 */

export const ROUTE_ID_PREFIX = "r1-";
export const MAX_FAST_CANDIDATES_PER_LOCATION = 3;
export const MAX_PRIVACY_CANDIDATES_PER_PATH = 3;

const ELIGIBLE_LIFECYCLE_STATES = new Set(["READY", "CANARY"]);

// tamara-next's VpnHop requires server_address to be an IP literal for any
// non-chained hop (no plaintext DNS bootstrap before the tunnel exists).
const isEligible = (node) =>
  ELIGIBLE_LIFECYCLE_STATES.has(node.lifecycleState) &&
  typeof node.transport === "string" &&
  node.transport.length > 0 &&
  typeof node.ipAddress === "string" &&
  node.ipAddress.length > 0 &&
  isUnderCapacity(node);

export function toPublicHop(node) {
  const hop = {
    transport: node.transport,
    server_address: node.ipAddress,
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

export function routeIdFor({ mode, entryLocationId = null, exitLocationId, nodes }) {
  const material = canonicalJsonString({
    v: 1,
    mode,
    entry: entryLocationId,
    exit: exitLocationId,
    hops: nodes.map((node) => ({ node_id: node.nodeId, ...toPublicHop(node) })),
  });
  return ROUTE_ID_PREFIX + bytesToHex(sha256(new TextEncoder().encode(material))).slice(0, 32);
}

const byLoadThenId = (a, b) => {
  const loadA = a.configuredUsers ?? Infinity;
  const loadB = b.configuredUsers ?? Infinity;
  if (loadA !== loadB) return loadA - loadB;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
};

/**
 * Least-loaded first, but one node per failure domain before any second
 * node from an already-represented domain, so the first N candidates are
 * as independent as the fleet allows. Deterministic for a given input.
 */
export function diverseOrder(nodes) {
  const sorted = [...nodes].sort(byLoadThenId);
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const node of sorted) {
    const domain = node.failureDomain ?? `node:${node.nodeId}`;
    if (seen.has(domain)) rest.push(node);
    else {
      seen.add(domain);
      first.push(node);
    }
  }
  return [...first, ...rest];
}

// Candidates for one region/mode share a label; priority decreases so the
// client tries the scheduler-preferred candidate first and fails over down
// the list.
const priorityAt = (index) => 100 - index * 10;

/**
 * Pure: no I/O. Returns internal candidates carrying hopNodeIds; callers
 * that publish must strip them (see publicRoute).
 */
export function buildRouteCandidates({ nodes, locations, allowedPaths }) {
  const locationById = new Map(locations.map((loc) => [loc.id, loc]));
  const eligible = nodes.filter(isEligible);
  const pool = (locationId, role) =>
    diverseOrder(eligible.filter((node) => node.locationId === locationId && node.role === role));

  const candidates = [];

  // Fast routes exist only where a direct allowed_paths row permits them.
  // (A missing row means "not permitted", never an implicit allow.)
  const directExits = new Set(allowedPaths.filter((p) => !p.entryLocationId).map((p) => p.exitLocationId));
  for (const location of locations) {
    if (!directExits.has(location.id)) continue;
    const exits = pool(location.id, "EXIT").slice(0, MAX_FAST_CANDIDATES_PER_LOCATION);
    exits.forEach((exitNode, index) => {
      const candidate = {
        id: routeIdFor({ mode: "fast", exitLocationId: location.id, nodes: [exitNode] }),
        label: location.displayName,
        region: location.countryCode,
        mode: "fast",
        priority: priorityAt(index),
        hops: [toPublicHop(exitNode)],
        hopNodeIds: [exitNode.nodeId],
      };
      if (exitNode.failureDomain) candidate.failure_domain = exitNode.failureDomain;
      candidates.push(candidate);
    });
  }

  for (const path of allowedPaths) {
    if (!path.entryLocationId) continue;
    const entryLocation = locationById.get(path.entryLocationId);
    const exitLocation = locationById.get(path.exitLocationId);
    if (!entryLocation || !exitLocation) continue;
    const relays = pool(path.entryLocationId, "RELAY");
    const exits = pool(path.exitLocationId, "EXIT");
    if (relays.length === 0 || exits.length === 0) continue;
    const count = Math.min(MAX_PRIVACY_CANDIDATES_PER_PATH, Math.max(relays.length, exits.length));
    const seenPairs = new Set();
    let index = 0;
    for (let k = 0; k < count; k += 1) {
      const relayNode = relays[k % relays.length];
      const exitNode = exits[k % exits.length];
      // A relay and exit must be distinct machines, or "two-hop" is a lie.
      if (relayNode.nodeId === exitNode.nodeId) continue;
      const pairKey = `${relayNode.nodeId}>${exitNode.nodeId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const candidate = {
        id: routeIdFor({
          mode: "privacy_plus",
          entryLocationId: path.entryLocationId,
          exitLocationId: path.exitLocationId,
          nodes: [relayNode, exitNode],
        }),
        label: `${entryLocation.displayName} → ${exitLocation.displayName} Privacy+`,
        region: exitLocation.countryCode,
        mode: "privacy_plus",
        priority: priorityAt(index),
        hops: [toPublicHop(relayNode), toPublicHop(exitNode)],
        hopNodeIds: [relayNode.nodeId, exitNode.nodeId],
      };
      if (exitNode.failureDomain) candidate.failure_domain = exitNode.failureDomain;
      candidates.push(candidate);
      index += 1;
    }
  }

  return candidates;
}

export function publicRoute(candidate) {
  const { hopNodeIds: _hidden, ...route } = candidate;
  return route;
}
