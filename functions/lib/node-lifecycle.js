/**
 * The fleet node lifecycle state machine (spec §7/§54 Phase 2). Pure and
 * side-effect-free by design (spec §42/§14: "keep core scheduler/
 * entitlement/state-transition logic pure and unit-testable") — no
 * Supabase client, no I/O. The admin API route
 * (functions/api/admin/nodes/[id]/lifecycle.js) is the only caller that
 * persists a transition.
 *
 * Phase 2 wired up admin-triggered transitions. Phase 8
 * (functions/lib/node-health-transition.js) adds the automated
 * health-based edges: READY<->DEGRADED, DEGRADED->FAILED, FAILED->READY.
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
  READY: ["DEGRADED", "DRAINING", "MAINTENANCE", "QUARANTINED"],
  // FAILED here is the Phase 8 automated edge: a node that goes silent
  // (functions/lib/node-health-transition.js) is moved straight to FAILED
  // from either READY or DEGRADED.
  DEGRADED: ["READY", "FAILED", "DRAINING", "MAINTENANCE", "QUARANTINED"],
  DRAINING: ["MAINTENANCE", "RETIRED", "READY", "QUARANTINED"],
  MAINTENANCE: ["READY", "DRAINING", "QUARANTINED"],
  // READY here is the Phase 8 automated recovery edge: a heartbeat with a
  // passing probe after a silence-triggered FAILED resumes normal streak
  // evaluation. FAILED reached any other way (agent crash loop, etc.) still
  // recovers the same way — a working probe is a working probe.
  FAILED: ["PROVISIONING", "READY", "QUARANTINED", "RETIRED"],
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
