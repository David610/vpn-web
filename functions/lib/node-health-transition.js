/**
 * Phase 8 pure decision logic for automated node-health lifecycle
 * transitions. No Supabase client, no I/O, following the same separation
 * node-lifecycle.js established. Two callers persist decisions made here:
 * functions/api/agent/heartbeat.js (probe transitions for the heartbeating
 * node, plus lazy silence detection for every other node) and
 * functions/api/admin/nodes.js (lazy silence detection on the admin
 * node-list read), both through functions/lib/node-silence-failover.js for
 * the silence case.
 *
 * Automation vs. admin authority: node-lifecycle.js's ALLOWED_TRANSITIONS
 * says what an ADMIN may do by hand, and is deliberately permissive (e.g.
 * MAINTENANCE->READY, WARMING_UP->FAILED). Automation is allowed a much
 * narrower set of moves, spelled out explicitly below rather than derived
 * from that table:
 *
 *   READY    -> DEGRADED  (FAILURE_THRESHOLD consecutive failed probes)
 *   DEGRADED -> READY     (SUCCESS_THRESHOLD consecutive passing probes)
 *   FAILED   -> READY     (one passing probe, or any heartbeat at all from
 *                          a node with no probe capability -- ONLY when
 *                          nodes.failed_reason is SILENCE; a canary abort,
 *                          boot timeout, or admin action stays FAILED)
 *   READY/DEGRADED -> FAILED  (silence only, via isNodeSilent)
 *
 * PROVISIONING, WARMING_UP, MAINTENANCE, DRAINING, QUARANTINED and RETIRED
 * are never a source state for an automated transition: they belong to the
 * admin, the CREATE_NODE operation (fleet-operations.js) or enrollment
 * (agent/enroll.js). Callers still re-check canTransitionLifecycle() before
 * writing, as defense in depth.
 */

export const SILENCE_THRESHOLD_MULTIPLIER = 3;

// Matches the agent's HEARTBEAT_INTERVAL (60s) in
// apps/provisioning-agent/src/main.rs -- keep these in sync; a drift here
// would change what "silent" means without a code change on the agent side.
export const HEARTBEAT_INTERVAL_MS = 60_000;

// The only states silence may move to FAILED. A PROVISIONING/WARMING_UP
// node's last_seen_at can legitimately be stale (e.g. a silence-FAILED node
// re-enrolled into PROVISIONING keeps its old last_seen_at until the new
// VPS enrolls), and MAINTENANCE/DRAINING/QUARANTINED/RETIRED are
// admin-owned states a node may be expected to be offline in.
export const SILENCE_ELIGIBLE_STATES = new Set(["READY", "DEGRADED"]);

export function isNodeSilent(node, nowMs, heartbeatIntervalMs) {
  if (!SILENCE_ELIGIBLE_STATES.has(node.lifecycle_state)) return false;
  if (!node.last_seen_at) return false;
  const lastSeenMs = new Date(node.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs > heartbeatIntervalMs * SILENCE_THRESHOLD_MULTIPLIER;
}

export const FAILURE_THRESHOLD = 3;
export const SUCCESS_THRESHOLD = 5;

// The only nodes.failed_reason automation may self-heal from. A canary
// abort, a boot timeout, or an admin action all leave a node FAILED for a
// reason that needs a human or a real replacement -- never a passing probe
// or a bare heartbeat alone. Flagged as a hard precondition by both the
// Phase 12a and Phase 12b specs before FEATURE_AUTO_NODE_HEALTH could
// safely combine with those other paths into FAILED.
const AUTO_RECOVERABLE_REASON = "SILENCE";

/**
 * Decides streak counters and any automated lifecycle transition for one
 * heartbeat from the node itself. probeOk is true/false for a node whose
 * agent ran a data-plane probe, or null/undefined for a node with no Clash
 * API configured (the agent omits probe_ok entirely in that case).
 * failedReason is the node's nodes.failed_reason column -- only meaningful,
 * and only ever read here, while lifecycleState is FAILED.
 */
export function evaluateProbeResult({ probeOk, currentFailures, currentSuccesses, lifecycleState, failedReason }) {
  const canAutoRecover = lifecycleState === "FAILED" && failedReason === AUTO_RECOVERABLE_REASON;

  if (probeOk === null || probeOk === undefined) {
    // A node with no probe capability neither earns nor loses streak
    // credit. The one exception is a silence-triggered FAILED: for a node
    // that cannot probe, authenticating and heartbeating at all is the
    // only evidence of recovery that will ever arrive -- without this it
    // could never leave FAILED automatically.
    return {
      failures: currentFailures,
      successes: currentSuccesses,
      nextState: canAutoRecover ? "READY" : null,
    };
  }

  if (probeOk) {
    if (canAutoRecover) {
      // Spec 4.3: a silence-triggered FAILED is reversed by the first
      // passing probe. It counts as one success, not as a full
      // SUCCESS_THRESHOLD streak.
      return { failures: 0, successes: 1, nextState: "READY" };
    }
    if (lifecycleState === "FAILED") {
      // FAILED for any other reason stays FAILED regardless of probe
      // result, until an admin or a real replacement acts.
      return { failures: currentFailures, successes: currentSuccesses, nextState: null };
    }
    const successes = currentSuccesses + 1;
    const shouldRecover = lifecycleState === "DEGRADED" && successes >= SUCCESS_THRESHOLD;
    return { failures: 0, successes, nextState: shouldRecover ? "READY" : null };
  }

  // A failed probe only ever produces DEGRADED, and only from READY.
  // FAILED is silence-only (spec 4.3/4.4): a node still heartbeating with
  // failing probes stays DEGRADED however long the streak grows.
  const failures = currentFailures + 1;
  const shouldDegrade = lifecycleState === "READY" && failures >= FAILURE_THRESHOLD;
  return { failures, successes: 0, nextState: shouldDegrade ? "DEGRADED" : null };
}
