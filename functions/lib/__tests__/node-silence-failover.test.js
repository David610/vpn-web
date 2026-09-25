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
});
