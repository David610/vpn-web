/**
 * Phase 8 pure decision logic for automated node-health lifecycle
 * transitions. No Supabase client, no I/O — functions/api/agent/heartbeat.js
 * is the only caller that persists a decision made here, following the same
 * separation node-lifecycle.js established.
 */

import { canTransitionLifecycle } from "./node-lifecycle.js";

export const SILENCE_THRESHOLD_MULTIPLIER = 3;

const NEVER_SILENCE_STATES = new Set(["QUARANTINED", "RETIRED"]);

export function isNodeSilent(node, nowMs, heartbeatIntervalMs) {
  if (!node.last_seen_at) return false;
  if (NEVER_SILENCE_STATES.has(node.lifecycle_state)) return false;
  const lastSeenMs = new Date(node.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs > heartbeatIntervalMs * SILENCE_THRESHOLD_MULTIPLIER;
}

export const FAILURE_THRESHOLD = 3;
export const SUCCESS_THRESHOLD = 5;

export function evaluateProbeResult({ probeOk, currentFailures, currentSuccesses, lifecycleState }) {
  if (probeOk === null || probeOk === undefined) {
    return { failures: currentFailures, successes: currentSuccesses, nextState: null };
  }

  if (probeOk) {
    const successes = currentSuccesses + 1;
    const shouldRecover = successes >= SUCCESS_THRESHOLD && canTransitionLifecycle(lifecycleState, "READY");
    return { failures: 0, successes, nextState: shouldRecover ? "READY" : null };
  }

  const failures = currentFailures + 1;
  let nextState = null;
  if (failures >= FAILURE_THRESHOLD) {
    if (canTransitionLifecycle(lifecycleState, "DEGRADED")) nextState = "DEGRADED";
    else if (canTransitionLifecycle(lifecycleState, "FAILED")) nextState = "FAILED";
  }
  return { failures, successes: 0, nextState };
}
