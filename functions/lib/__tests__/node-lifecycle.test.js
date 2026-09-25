import { describe, it, expect } from "vitest";
import {
  NODE_LIFECYCLE_STATES,
  isValidLifecycleState,
  canTransitionLifecycle,
  allowedNextLifecycleStates,
} from "../node-lifecycle.js";

describe("isValidLifecycleState", () => {
  it("accepts every declared state", () => {
    for (const state of NODE_LIFECYCLE_STATES) {
      expect(isValidLifecycleState(state)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isValidLifecycleState("ACTIVE")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidLifecycleState(null)).toBe(false);
    expect(isValidLifecycleState(undefined)).toBe(false);
    expect(isValidLifecycleState(123)).toBe(false);
  });
});

describe("canTransitionLifecycle", () => {
  it("allows READY to DRAINING", () => {
    expect(canTransitionLifecycle("READY", "DRAINING")).toBe(true);
  });

  it("allows an operator to cancel a drain back to READY", () => {
    expect(canTransitionLifecycle("DRAINING", "READY")).toBe(true);
  });

  it("rejects RETIRED to anything — it is terminal", () => {
    for (const state of NODE_LIFECYCLE_STATES) {
      expect(canTransitionLifecycle("RETIRED", state)).toBe(false);
    }
  });

  it("only allows QUARANTINED to move to RETIRED", () => {
    for (const state of NODE_LIFECYCLE_STATES) {
      if (state === "RETIRED") {
        expect(canTransitionLifecycle("QUARANTINED", state)).toBe(true);
      } else {
        expect(canTransitionLifecycle("QUARANTINED", state)).toBe(false);
      }
    }
  });

  it("rejects a READY node jumping straight to RETIRED", () => {
    // Must drain (or fail/be quarantined) first — a live node is never
    // retired directly.
    expect(canTransitionLifecycle("READY", "RETIRED")).toBe(false);
  });

  it("rejects transitions from or to an invalid state", () => {
    expect(canTransitionLifecycle("BOGUS", "READY")).toBe(false);
    expect(canTransitionLifecycle("READY", "BOGUS")).toBe(false);
  });

  it("allows DEGRADED to FAILED — Phase 8 automated health transition", () => {
    expect(canTransitionLifecycle("DEGRADED", "FAILED")).toBe(true);
  });

  it("allows FAILED to READY — Phase 8 automated recovery after silence", () => {
    expect(canTransitionLifecycle("FAILED", "READY")).toBe(true);
  });

  it("allows READY to FAILED directly — Phase 8 silence edge (a silent node never traverses DEGRADED via a probe it can't send)", () => {
    expect(canTransitionLifecycle("READY", "FAILED")).toBe(true);
  });

  it("allows FAILED to DRAINING (Phase 12a replace-node drain path)", () => {
    expect(canTransitionLifecycle("FAILED", "DRAINING")).toBe(true);
  });

  it("every declared state's transition targets are themselves valid states", () => {
    for (const state of NODE_LIFECYCLE_STATES) {
      for (const next of allowedNextLifecycleStates(state)) {
        expect(NODE_LIFECYCLE_STATES).toContain(next);
      }
    }
  });
});

describe("allowedNextLifecycleStates", () => {
  it("returns an empty array for RETIRED", () => {
    expect(allowedNextLifecycleStates("RETIRED")).toEqual([]);
  });

  it("returns an empty array for an invalid state", () => {
    expect(allowedNextLifecycleStates("BOGUS")).toEqual([]);
  });

  it("returns a fresh array each call, not a shared reference", () => {
    const a = allowedNextLifecycleStates("READY");
    const b = allowedNextLifecycleStates("READY");
    expect(a).not.toBe(b);
    a.push("MUTATED");
    expect(allowedNextLifecycleStates("READY")).not.toContain("MUTATED");
  });
});

describe("Phase 12b CANARY state", () => {
  it("allows WARMING_UP to CANARY (canary-mode replacement)", () => {
    expect(canTransitionLifecycle("WARMING_UP", "CANARY")).toBe(true);
  });

  it("allows CANARY to READY (canary promotion)", () => {
    expect(canTransitionLifecycle("CANARY", "READY")).toBe(true);
  });

  it("allows CANARY to FAILED (canary abort)", () => {
    expect(canTransitionLifecycle("CANARY", "FAILED")).toBe(true);
  });

  it("includes CANARY in the valid state list", () => {
    expect(isValidLifecycleState("CANARY")).toBe(true);
  });

  it("allows CANARY to QUARANTINED (admin can quarantine a node mid-canary, e.g. found compromised)", () => {
    expect(canTransitionLifecycle("CANARY", "QUARANTINED")).toBe(true);
  });

  it("allows CANARY to MAINTENANCE (admin operational override mid-canary)", () => {
    expect(canTransitionLifecycle("CANARY", "MAINTENANCE")).toBe(true);
  });
});
