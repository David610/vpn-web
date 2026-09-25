import { describe, it, expect } from "vitest";
import {
  isNodeSilent,
  SILENCE_THRESHOLD_MULTIPLIER,
  evaluateProbeResult,
  FAILURE_THRESHOLD,
  SUCCESS_THRESHOLD,
} from "../node-health-transition.js";

const HEARTBEAT_INTERVAL_MS = 60_000;

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
});
