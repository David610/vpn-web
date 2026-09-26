import { signRouteDirectory } from "../lib/route-signing.js";
import { withV1User, v1Json } from "../lib/v1-http.js";

/**
 * GET /v1/routes -- the signed, versioned route directory tamara-next's
 * RouteDirectoryVerifier already verifies. Requires authentication like
 * every other /v1 route, even though the directory itself carries no
 * per-user data, matching the contract's own auth model.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/routes", async (db) => {
    const [{ data: nodes, error: nodesError }, { data: locations, error: locationsError }, { data: allowedPaths, error: pathsError }] =
      await Promise.all([
        db
          .from("nodes")
          .select(
            "node_id, role, location_id, lifecycle_state, configured_users, max_sessions, hostname, ip_address, failure_domain, transport, transport_port, tls_server_name, reality_public_key, reality_short_id, reality_fingerprint, vless_flow, hysteria2_obfs_type"
          )
          .in("lifecycle_state", ["READY", "CANARY"]),
        db.from("locations").select("id, country_code, display_name").eq("enabled", true),
        db.from("allowed_paths").select("entry_location_id, exit_location_id").eq("enabled", true),
      ]);
    if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);
    if (locationsError) throw new Error(`locations lookup failed: ${locationsError.message}`);
    if (pathsError) throw new Error(`allowed_paths lookup failed: ${pathsError.message}`);

    const mappedNodes = (nodes ?? []).map((n) => ({
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
    }));
    const mappedLocations = (locations ?? []).map((l) => ({
      id: l.id,
      countryCode: l.country_code,
      displayName: l.display_name,
    }));
    const mappedPaths = (allowedPaths ?? []).map((p) => ({
      entryLocationId: p.entry_location_id,
      exitLocationId: p.exit_location_id,
    }));

    const envelope = await signRouteDirectory(db, {
      nodes: mappedNodes,
      locations: mappedLocations,
      allowedPaths: mappedPaths,
      privateKeyHex: context.env.ROUTE_SIGNING_PRIVATE_KEY,
      keyId: context.env.ROUTE_SIGNING_KEY_ID,
    });
    return v1Json(envelope);
  });
