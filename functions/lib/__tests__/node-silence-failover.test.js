import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { failSilentNodes } from "../node-silence-failover.js";
import { HEARTBEAT_INTERVAL_MS } from "../node-health-transition.js";

describe("failSilentNodes", () => {
  it("transitions a silent node to FAILED", async () => {
    const db = makeFakeSupabase({
      nodes: [{ node_id: "n1", lifecycle_state: "READY", last_seen_at: new Date(Date.now() - 10 * HEARTBEAT_INTERVAL_MS).toISOString() }],
      operational_alerts: [],
    });
    const failedIds = await failSilentNodes(db, db._tables.nodes, Date.now());
    expect(failedIds).toEqual(["n1"]);
  });

  it("sets lifecycle_state_changed_at when transitioning a silent node to FAILED", async () => {
    const db = makeFakeSupabase({
      nodes: [{ node_id: "n1", lifecycle_state: "READY", last_seen_at: new Date(Date.now() - 10 * HEARTBEAT_INTERVAL_MS).toISOString() }],
      operational_alerts: [],
    });
    const before = Date.now();
    await failSilentNodes(db, db._tables.nodes, Date.now());
    const changedAt = new Date(db._tables.nodes[0].lifecycle_state_changed_at).getTime();
    expect(changedAt).toBeGreaterThanOrEqual(before);
  });

  // failed_reason precondition (Phase 12a/12b specs): this is the ONE path
  // node-health-transition.js's evaluateProbeResult treats as
  // auto-recoverable from a single passing probe -- every other route into
  // FAILED must record a different reason so it can't be waved back to
  // READY the same easy way.
  it("records failed_reason as SILENCE when transitioning a silent node to FAILED", async () => {
    const db = makeFakeSupabase({
      nodes: [{ node_id: "n1", lifecycle_state: "READY", last_seen_at: new Date(Date.now() - 10 * HEARTBEAT_INTERVAL_MS).toISOString() }],
      operational_alerts: [],
    });
    await failSilentNodes(db, db._tables.nodes, Date.now());
    expect(db._tables.nodes[0].failed_reason).toBe("SILENCE");
  });
});
