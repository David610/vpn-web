/**
 * Multi-node direct-routing scheduler (spec 54 Phase 5). Picks a concrete
 * EXIT node for a device, given a target exit location -- the gap
 * FLEET_PLATFORM_PLAN.md identifies explicitly: connection_profiles and
 * allowed_paths resolve only to *locations*; nothing before this picked a
 * specific *node* within one.
 *
 * This module is additive and self-contained. Nothing in
 * functions/lib/resolve-node.js or its ~7 existing callers calls into it
 * yet -- the old single-node path (resolveNodeForUser() always returning
 * "node-1") is untouched and stays the production behavior until a later
 * phase migrates callers over one at a time. See scheduleNodeForDevice's
 * own comment for the FEATURE_MULTI_NODE_SCHEDULING flag this guards.
 */

/**
 * Pure placement logic: no I/O, no Supabase client. `candidates` is
 * already filtered to nodes that are READY, role EXIT, in the requested
 * location, and not retired -- this function only decides *which one*.
 *
 * Sticky: if `stickyNodeId` names a node still present in `candidates`,
 * it wins outright, regardless of load -- a device should not be bounced
 * to a different node just because another node now has fewer sessions.
 * Otherwise, picks the candidate with the fewest configured_users
 * (least-loaded), breaking ties on node_id for a deterministic, testable
 * result.
 */
export function selectNodeForDevice({ candidates, stickyNodeId }) {
  if (!candidates || candidates.length === 0) return null;

  if (stickyNodeId) {
    const sticky = candidates.find((node) => node.nodeId === stickyNodeId);
    if (sticky) return sticky.nodeId;
  }

  const sorted = [...candidates].sort((a, b) => {
    const loadDiff = (a.configuredUsers ?? 0) - (b.configuredUsers ?? 0);
    if (loadDiff !== 0) return loadDiff;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
  return sorted[0].nodeId;
}

function isUnderCapacity(node) {
  if (node.maxSessions == null) return true;
  return (node.configuredUsers ?? 0) < node.maxSessions;
}

/**
 * DB-facing wrapper: loads candidate nodes, the sticky assignment (if
 * any), and the allowed_paths row for the requested direct route, then
 * calls selectNodeForDevice() and persists the result.
 *
 * Fails closed exactly like allowed_paths' own migration comment requires
 * ("no matching row" means "not permitted", never an implicit allow) --
 * returns null rather than picking a node when no enabled direct
 * allowed_paths row exists for exitLocationId, or when no candidate node
 * is available.
 *
 * Gated by env.FEATURE_MULTI_NODE_SCHEDULING === "true" (this codebase has
 * no existing feature-flag convention to reuse -- see plan doc research).
 * Callers must check the flag themselves before invoking this; it is not
 * checked here so unit tests can exercise the scheduling logic without
 * needing to fake env.
 */
export async function scheduleNodeForDevice(supabaseAdmin, { deviceId, exitLocationId }) {
  const [{ data: allowedPath, error: pathError }, { data: sticky, error: stickyError }] = await Promise.all([
    supabaseAdmin
      .from("allowed_paths")
      .select("id")
      .eq("exit_location_id", exitLocationId)
      .is("entry_location_id", null)
      .eq("enabled", true)
      .maybeSingle(),
    supabaseAdmin
      .from("device_node_assignments")
      .select("node_id")
      .eq("device_id", deviceId)
      .maybeSingle(),
  ]);
  if (pathError) throw new Error(`allowed_paths lookup failed: ${pathError.message}`);
  if (stickyError) throw new Error(`device_node_assignments lookup failed: ${stickyError.message}`);
  if (!allowedPath) return null;

  const { data: nodes, error: nodesError } = await supabaseAdmin
    .from("nodes")
    .select("node_id, configured_users, max_sessions")
    .eq("role", "EXIT")
    .eq("lifecycle_state", "READY")
    .eq("location_id", exitLocationId);
  if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);

  const candidates = (nodes ?? [])
    .map((node) => ({
      nodeId: node.node_id,
      configuredUsers: node.configured_users,
      maxSessions: node.max_sessions,
    }))
    .filter(isUnderCapacity);

  const nodeId = selectNodeForDevice({ candidates, stickyNodeId: sticky?.node_id ?? null });
  if (!nodeId) return null;

  if (nodeId !== sticky?.node_id) {
    const { error: upsertError } = await supabaseAdmin
      .from("device_node_assignments")
      .upsert({ device_id: deviceId, node_id: nodeId }, { onConflict: "device_id" });
    if (upsertError) throw new Error(`device_node_assignments upsert failed: ${upsertError.message}`);
  }

  return nodeId;
}
