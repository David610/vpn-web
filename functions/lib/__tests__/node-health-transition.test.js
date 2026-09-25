import { describe, it, expect } from "vitest";
import { isNodeSilent, SILENCE_THRESHOLD_MULTIPLIER } from "../node-health-transition.js";

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
