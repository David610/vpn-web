import { buildRouteCandidates, publicRoute } from "./route-candidates.js";

const NODE_COLUMNS =
  "node_id, role, location_id, lifecycle_state, configured_users, max_sessions, hostname, ip_address, failure_domain, transport, transport_port, tls_server_name, reality_public_key, reality_short_id, reality_fingerprint, vless_flow, hysteria2_obfs_type";

/**
 * Loads the fleet state route candidates are computed from. GET /v1/routes
 * and POST /v1/vpn/authorize both call this, so the two can only disagree
 * if fleet state itself changed between the calls -- which authorize
 * detects (route id no longer present) and rejects instead of rescheduling.
 */
export async function loadRouteInputs(db) {
  const [
    { data: nodes, error: nodesError },
    { data: locations, error: locationsError },
    { data: allowedPaths, error: pathsError },
  ] = await Promise.all([
    db.from("nodes").select(NODE_COLUMNS).in("lifecycle_state", ["READY", "CANARY"]),
    db.from("locations").select("id, country_code, display_name").eq("enabled", true),
    db.from("allowed_paths").select("entry_location_id, exit_location_id").eq("enabled", true),
  ]);
  if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);
  if (locationsError) throw new Error(`locations lookup failed: ${locationsError.message}`);
  if (pathsError) throw new Error(`allowed_paths lookup failed: ${pathsError.message}`);

  return {
    nodes: (nodes ?? []).map((n) => ({
      nodeId: n.node_id,
      role: n.role,
      locationId: n.location_id,
      lifecycleState: n.lifecycle_state,
      configuredUsers: n.configured_users,
      maxSessions: n.max_sessions,
      hostname: n.hostname,
      ipAddress: n.ip_address,
      failureDomain: n.failure_domain,
      transport: n.transport,
      transportPort: n.transport_port,
      tlsServerName: n.tls_server_name,
      realityPublicKey: n.reality_public_key,
      realityShortId: n.reality_short_id,
      realityFingerprint: n.reality_fingerprint,
      vlessFlow: n.vless_flow,
      hysteria2ObfsType: n.hysteria2_obfs_type,
    })),
    locations: (locations ?? []).map((l) => ({ id: l.id, countryCode: l.country_code, displayName: l.display_name })),
    allowedPaths: (allowedPaths ?? []).map((p) => ({
      entryLocationId: p.entry_location_id,
      exitLocationId: p.exit_location_id,
    })),
  };
}

/**
 * Pure route-directory rendering: every published route is a concrete
 * candidate from buildRouteCandidates (exact physical hops, content-derived
 * id), with internal node ids stripped. A location/pair with no eligible
 * candidate produces no route, never a partial one.
 */
export function renderRoutes({ nodes, locations, allowedPaths }) {
  return { routes: buildRouteCandidates({ nodes, locations, allowedPaths }).map(publicRoute) };
}
