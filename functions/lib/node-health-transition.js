/**
 * Phase 8 pure decision logic for automated node-health lifecycle
 * transitions. No Supabase client, no I/O — functions/api/agent/heartbeat.js
 * is the only caller that persists a decision made here, following the same
 * separation node-lifecycle.js established.
 */

export const SILENCE_THRESHOLD_MULTIPLIER = 3;

const NEVER_SILENCE_STATES = new Set(["QUARANTINED", "RETIRED"]);

export function isNodeSilent(node, nowMs, heartbeatIntervalMs) {
  if (!node.last_seen_at) return false;
  if (NEVER_SILENCE_STATES.has(node.lifecycle_state)) return false;
  const lastSeenMs = new Date(node.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs > heartbeatIntervalMs * SILENCE_THRESHOLD_MULTIPLIER;
}
