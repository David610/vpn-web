/**
 * The fleet node lifecycle state machine (spec §7/§54 Phase 2). Pure and
 * side-effect-free by design (spec §42/§14: "keep core scheduler/
 * entitlement/state-transition logic pure and unit-testable") — no
 * Supabase client, no I/O.
 *
 * ALLOWED_TRANSITIONS is the table of what an ADMIN may do by hand
 * (functions/api/admin/nodes/[id]/lifecycle.js), plus the edges the
 * CREATE_NODE operation (fleet-operations.js) and enrollment
 * (agent/enroll.js) rely on. It is deliberately permissive and must not be
 * narrowed to fit automation.
 *
 * Phase 8 added the health-based edges READY<->DEGRADED, READY->FAILED,
 * DEGRADED->FAILED and FAILED->READY. Phase 12a added FAILED->DRAINING (a
 * FAILED node can be replaced, same as a READY or DEGRADED one). Automation
 * does NOT get everything this table allows: functions/lib/node-health-transition.js
 * and functions/lib/fleet-operations.js's REPLACE_NODE handlers each spell
 * out their own narrower set of automated moves, using canTransitionLifecycle
 * only as a secondary guard.
 */

export const NODE_LIFECYCLE_STATES = Object.freeze([
  "PROVISIONING",
  "WARMING_UP",
  "READY",
  "DEGRADED",
  "DRAINING",
  "MAINTENANCE",
  "FAILED",
  "QUARANTINED",
  "RETIRED",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  PROVISIONING: ["WARMING_UP", "FAILED", "QUARANTINED"],
  WARMING_UP: ["READY", "FAILED", "QUARANTINED"],
  // FAILED here is the Phase 8 automated silence edge: a node that stops
  // heartbeating entirely (isNodeSilent in node-health-transition.js) is
  // moved straight to FAILED from READY, bypassing the probe-streak
  // hysteresis in evaluateProbeResult -- a silent node sends no heartbeats
  // of its own, so it can never traverse READY->DEGRADED via a failed
  // probe first. A node that is still heartbeating but failing probes
  // still goes through DEGRADED via evaluateProbeResult as before; this
  // edge exists only for the orthogonal "gone completely dark" case.
  READY: ["DEGRADED", "FAILED", "DRAINING", "MAINTENANCE", "QUARANTINED"],
  DEGRADED: ["READY", "FAILED", "DRAINING", "MAINTENANCE", "QUARANTINED"],
  DRAINING: ["MAINTENANCE", "RETIRED", "READY", "QUARANTINED"],
  MAINTENANCE: ["READY", "DRAINING", "QUARANTINED"],
  // READY here is the Phase 8 automated recovery edge: after a
  // silence-triggered FAILED, a single heartbeat with a passing probe (or
  // any heartbeat at all, for a node with no probe capability) resumes
  // normal streak evaluation. See evaluateProbeResult.
  // DRAINING here is the Phase 12a replace-node edge: a FAILED node being
  // replaced (functions/lib/fleet-operations.js's DRAIN_OLD_NODE step) must
  // reach DRAINING the same way a READY or DEGRADED node being replaced
  // does -- a FAILED node's own passive-drain path (its devices reconnecting
  // via the scheduler's READY-only filter) does not depend on whether the
  // old node is reachable at all.
  FAILED: ["PROVISIONING", "READY", "DRAINING", "QUARANTINED", "RETIRED"],
  // Quarantine is deliberately a one-way security control (spec §45's
  // blast-radius containment): a node suspected of compromise never
  // returns to serving traffic from this state. The only way out is
  // RETIRED, followed by provisioning a fresh replacement.
  QUARANTINED: ["RETIRED"],
  RETIRED: [],
});

export function isValidLifecycleState(state) {
  return typeof state === "string" && NODE_LIFECYCLE_STATES.includes(state);
}

export function canTransitionLifecycle(from, to) {
  if (!isValidLifecycleState(from) || !isValidLifecycleState(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedNextLifecycleStates(from) {
  return isValidLifecycleState(from) ? [...ALLOWED_TRANSITIONS[from]] : [];
}
