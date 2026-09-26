import { describe, it, expect } from "vitest";
import {
  isNodeSilent,
  SILENCE_THRESHOLD_MULTIPLIER,
  evaluateProbeResult,
  FAILURE_THRESHOLD,
  SUCCESS_THRESHOLD,
  SILENCE_ELIGIBLE_STATES,
  HEARTBEAT_INTERVAL_MS,
} from "../node-health-transition.js";

describe("isNodeSilent", () => {
  it("is not silent when last_seen_at is recent", () => {
    const node = { last_seen_at: new Date(Date.now() - 10_000).toISOString(), lifecycle_state: "READY" };
    expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(false);
  });

  it("is silent past 3x the heartbeat interval", () => {
    const now = Date.now();
    const staleAt = new Date(now - HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER - 1000).toISOString();
    const node = { last_seen_at: staleAt, lifecycle_state: "READY" };
    expect(isNodeSilent(node, now, HEARTBEAT_INTERVAL_MS)).toBe(true);
  });

  it("is not silent exactly at the threshold boundary minus one ms", () => {
    const now = Date.now();
    const almostStale = new Date(now - HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER + 1000).toISOString();
    const node = { last_seen_at: almostStale, lifecycle_state: "READY" };
    expect(isNodeSilent(node, now, HEARTBEAT_INTERVAL_MS)).toBe(false);
  });

  it("is never silent for a node that has never heartbeated (last_seen_at null)", () => {
    // A brand-new PROVISIONING node has no last_seen_at yet; that is not
    // the same failure mode as "went silent after being healthy."
    const node = { last_seen_at: null, lifecycle_state: "PROVISIONING" };
    expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(false);
  });

  it("is never silent for QUARANTINED — it is expected to be offline", () => {
    const staleAt = new Date(Date.now() - 999_999_999).toISOString();
    const node = { last_seen_at: staleAt, lifecycle_state: "QUARANTINED" };
    expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(false);
  });

  it("is never silent for RETIRED", () => {
    const staleAt = new Date(Date.now() - 999_999_999).toISOString();
    const node = { last_seen_at: staleAt, lifecycle_state: "RETIRED" };
    expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(false);
  });

  it("is silent for a stale DEGRADED node", () => {
    const staleAt = new Date(Date.now() - 999_999_999).toISOString();
    const node = { last_seen_at: staleAt, lifecycle_state: "DEGRADED" };
    expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(true);
  });

  // Only READY/DEGRADED are silence-eligible. PROVISIONING matters most: a
  // silence-FAILED node re-enrolled by an admin keeps its stale
  // last_seen_at until the new VPS enrolls and must not bounce back to
  // FAILED in the meantime.
  it.each(["PROVISIONING", "WARMING_UP", "MAINTENANCE", "DRAINING", "FAILED"])(
    "is never silent for %s, even with a very stale last_seen_at",
    (lifecycleState) => {
      const staleAt = new Date(Date.now() - 999_999_999).toISOString();
      const node = { last_seen_at: staleAt, lifecycle_state: lifecycleState };
      expect(isNodeSilent(node, Date.now(), HEARTBEAT_INTERVAL_MS)).toBe(false);
    }
  );

  it("exposes exactly READY and DEGRADED as silence-eligible", () => {
    expect([...SILENCE_ELIGIBLE_STATES].sort()).toEqual(["DEGRADED", "READY"]);
  });

  it("uses the agent's 60s heartbeat interval", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });
});

describe("evaluateProbeResult", () => {
  const base = { currentFailures: 0, currentSuccesses: 0, lifecycleState: "READY" };

  it("increments the failure streak on a failed probe without transitioning below threshold", () => {
    const result = evaluateProbeResult({ ...base, probeOk: false, currentFailures: 1 });
    expect(result).toEqual({ failures: 2, successes: 0, nextState: null });
  });

  it("transitions READY to DEGRADED at the failure threshold", () => {
    const result = evaluateProbeResult({ ...base, probeOk: false, currentFailures: FAILURE_THRESHOLD - 1 });
    expect(result.failures).toBe(FAILURE_THRESHOLD);
    expect(result.nextState).toBe("DEGRADED");
  });

  it("resets the failure streak to 0 on any success", () => {
    const result = evaluateProbeResult({ ...base, probeOk: true, currentFailures: 2 });
    expect(result.failures).toBe(0);
    expect(result.successes).toBe(1);
  });

  it("does not accumulate across an ok/fail/ok/fail oscillation", () => {
    let state = { currentFailures: 0, currentSuccesses: 0 };
    for (const ok of [true, false, true, false, true, false]) {
      const r = evaluateProbeResult({ probeOk: ok, currentFailures: state.currentFailures, currentSuccesses: state.currentSuccesses, lifecycleState: "READY" });
      state = { currentFailures: r.failures, currentSuccesses: r.successes };
      expect(r.nextState).toBeNull();
    }
    expect(state.currentFailures).toBeLessThan(FAILURE_THRESHOLD);
  });

  it("transitions DEGRADED to READY at the success threshold", () => {
    const result = evaluateProbeResult({
      probeOk: true,
      currentFailures: 0,
      currentSuccesses: SUCCESS_THRESHOLD - 1,
      lifecycleState: "DEGRADED",
    });
    expect(result.successes).toBe(SUCCESS_THRESHOLD);
    expect(result.nextState).toBe("READY");
  });

  it("does not transition READY on success — already healthy", () => {
    const result = evaluateProbeResult({ ...base, probeOk: true, currentSuccesses: SUCCESS_THRESHOLD - 1 });
    expect(result.nextState).toBeNull();
  });

  it("does not transition a node in MAINTENANCE regardless of probe result", () => {
    const result = evaluateProbeResult({
      probeOk: false,
      currentFailures: FAILURE_THRESHOLD - 1,
      currentSuccesses: 0,
      lifecycleState: "MAINTENANCE",
    });
    expect(result.nextState).toBeNull();
  });

  it("leaves streaks and state completely untouched when probeOk is null", () => {
    const result = evaluateProbeResult({ probeOk: null, currentFailures: 2, currentSuccesses: 0, lifecycleState: "READY" });
    expect(result).toEqual({ failures: 2, successes: 0, nextState: null });
  });

  // C1: admin-owned states (and WARMING_UP, owned by the CREATE_NODE
  // operation) are never recovered to READY by automation, however long
  // the success streak -- ALLOWED_TRANSITIONS permits X->READY for these
  // only as an admin action.
  it.each(["MAINTENANCE", "DRAINING", "WARMING_UP", "PROVISIONING"])(
    "never recovers %s to READY on a long success streak",
    (lifecycleState) => {
      for (const currentSuccesses of [SUCCESS_THRESHOLD - 1, SUCCESS_THRESHOLD, 50]) {
        const result = evaluateProbeResult({ probeOk: true, currentFailures: 0, currentSuccesses, lifecycleState });
        expect(result.successes).toBeGreaterThanOrEqual(SUCCESS_THRESHOLD);
        expect(result.nextState).toBeNull();
      }
    }
  );

  // C2: a failed probe only ever produces DEGRADED, and only from READY.
  it.each(["DEGRADED", "WARMING_UP", "PROVISIONING", "MAINTENANCE", "DRAINING", "FAILED"])(
    "never transitions %s on 3+ consecutive failed probes",
    (lifecycleState) => {
      for (const currentFailures of [FAILURE_THRESHOLD - 1, FAILURE_THRESHOLD, 50]) {
        const result = evaluateProbeResult({ probeOk: false, currentFailures, currentSuccesses: 0, lifecycleState });
        expect(result.failures).toBeGreaterThanOrEqual(FAILURE_THRESHOLD);
        expect(result.nextState).toBeNull();
      }
    }
  );

  it("keeps a DEGRADED node DEGRADED (never FAILED) however long the failure streak", () => {
    const result = evaluateProbeResult({ probeOk: false, currentFailures: FAILURE_THRESHOLD, currentSuccesses: 0, lifecycleState: "DEGRADED" });
    expect(result).toEqual({ failures: FAILURE_THRESHOLD + 1, successes: 0, nextState: null });
  });

  it("does not recover DEGRADED below the success threshold", () => {
    const result = evaluateProbeResult({ probeOk: true, currentFailures: 0, currentSuccesses: SUCCESS_THRESHOLD - 2, lifecycleState: "DEGRADED" });
    expect(result.nextState).toBeNull();
  });

  it("exits FAILED to READY on a single passing probe, counting it as one success, when failedReason is SILENCE", () => {
    const result = evaluateProbeResult({ probeOk: true, currentFailures: 2, currentSuccesses: 0, lifecycleState: "FAILED", failedReason: "SILENCE" });
    expect(result).toEqual({ failures: 0, successes: 1, nextState: "READY" });
  });

  it("does not let stale pre-FAILED successes carry over when exiting FAILED", () => {
    const result = evaluateProbeResult({ probeOk: true, currentFailures: 0, currentSuccesses: 3, lifecycleState: "FAILED", failedReason: "SILENCE" });
    expect(result).toEqual({ failures: 0, successes: 1, nextState: "READY" });
  });

  it("keeps a FAILED node FAILED on a failed probe", () => {
    const result = evaluateProbeResult({ probeOk: false, currentFailures: 0, currentSuccesses: 0, lifecycleState: "FAILED", failedReason: "SILENCE" });
    expect(result.nextState).toBeNull();
  });

  // Null-probe ruling: a node with no Clash API configured can never send a
  // passing probe, so any authenticated heartbeat is enough to leave FAILED
  // -- but only when failedReason says silence is why it's here at all.
  it("recovers a FAILED node with no probe capability (probeOk null) to READY, streaks untouched, when failedReason is SILENCE", () => {
    const result = evaluateProbeResult({ probeOk: null, currentFailures: 1, currentSuccesses: 0, lifecycleState: "FAILED", failedReason: "SILENCE" });
    expect(result).toEqual({ failures: 1, successes: 0, nextState: "READY" });
  });

  it("treats an omitted probe (undefined) the same as null for FAILED recovery", () => {
    const result = evaluateProbeResult({ probeOk: undefined, currentFailures: 0, currentSuccesses: 0, lifecycleState: "FAILED", failedReason: "SILENCE" });
    expect(result.nextState).toBe("READY");
  });

  // failed_reason precondition (flagged by both the Phase 12a and 12b
  // specs): automation may only self-heal a FAILED node it put there for
  // the one reason it was designed to reverse from a single probe/heartbeat
  // (silence). A canary abort, a boot timeout, or an admin action all leave
  // a node FAILED for a reason that needs a human or a real replacement --
  // never a passing probe alone.
  it.each(["CANARY_ABORT", "BOOT_TIMEOUT", "ADMIN"])(
    "does not recover a FAILED node on a passing probe when failedReason is %s",
    (failedReason) => {
      const result = evaluateProbeResult({ probeOk: true, currentFailures: 0, currentSuccesses: 0, lifecycleState: "FAILED", failedReason });
      expect(result.nextState).toBeNull();
    }
  );

  it.each(["CANARY_ABORT", "BOOT_TIMEOUT", "ADMIN"])(
    "does not recover a FAILED node with no probe capability when failedReason is %s",
    (failedReason) => {
      const result = evaluateProbeResult({ probeOk: null, currentFailures: 0, currentSuccesses: 0, lifecycleState: "FAILED", failedReason });
      expect(result.nextState).toBeNull();
    }
  );

  it("does not recover a FAILED node when failedReason is missing entirely (fail closed, not fail open)", () => {
    const result = evaluateProbeResult({ probeOk: true, currentFailures: 0, currentSuccesses: 0, lifecycleState: "FAILED" });
    expect(result.nextState).toBeNull();
  });

  it.each(["READY", "DEGRADED", "MAINTENANCE", "DRAINING", "PROVISIONING", "WARMING_UP", "QUARANTINED", "RETIRED"])(
    "never transitions %s on a null probe",
    (lifecycleState) => {
      const result = evaluateProbeResult({ probeOk: null, currentFailures: 0, currentSuccesses: 0, lifecycleState });
      expect(result.nextState).toBeNull();
    }
  );
});
