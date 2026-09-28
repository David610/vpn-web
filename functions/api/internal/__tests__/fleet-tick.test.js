import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const nodesSelectIn = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    rpc,
    from: vi.fn((table) => {
      if (table === "nodes") return { select: vi.fn().mockReturnValue({ in: nodesSelectIn }) };
      // account-service.js's finalizeAccountDeletions queries other tables;
      // an empty-result stub is enough since its outcome isn't under test here.
      return {
        select: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
    }),
  })),
}));
const advanceOperation = vi.fn();
vi.mock("../../../lib/fleet-operations.js", () => ({ advanceOperation }));
const autoReplaceFailedNodes = vi.fn();
vi.mock("../../../lib/node-auto-replace.js", () => ({ autoReplaceFailedNodes }));
const autoScaleFullLocations = vi.fn();
vi.mock("../../../lib/node-auto-scale.js", () => ({ autoScaleFullLocations }));
const failSilentNodes = vi.fn();
vi.mock("../../../lib/node-silence-failover.js", () => ({ failSilentNodes }));

const { onRequestPost } = await import("../fleet-tick.js");
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k", FLEET_TICK_SECRET: "s3cret" };

function req(secret) {
  return new Request("https://x.test/api/internal/fleet-tick", {
    method: "POST",
    headers: secret ? { "X-Fleet-Tick-Secret": secret } : {},
  });
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [{ id: "op-1", type: "CREATE_NODE", node_id: "n1" }], error: null });
  advanceOperation.mockReset().mockResolvedValue({ status: "RUNNING", step: "AWAIT_ENROLLMENT" });
  autoReplaceFailedNodes.mockReset().mockResolvedValue([]);
  autoScaleFullLocations.mockReset().mockResolvedValue([]);
  nodesSelectIn.mockReset().mockResolvedValue({ data: [{ node_id: "n1", lifecycle_state: "READY", last_seen_at: null }], error: null });
  failSilentNodes.mockReset().mockResolvedValue([]);
});

describe("POST /api/internal/fleet-tick", () => {
  it.each([[null], ["wrong"], ["S3CRET"], ["s3cret-and-more"]])("rejects a missing/wrong secret (%s) before touching the DB", async (secret) => {
    const res = await onRequestPost({ env, request: req(secret) });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when no secret is configured at all", async () => {
    const res = await onRequestPost({ env: { ...env, FLEET_TICK_SECRET: undefined }, request: req("") });
    expect(res.status).toBe(401);
  });

  it("leases due operations and advances each", async () => {
    const res = await onRequestPost({ env, request: req("s3cret") });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("lease_fleet_operations", { p_limit: 10, p_lease_seconds: 120 });
    expect(await res.json()).toMatchObject({ leased: 1, results: [{ id: "op-1", status: "RUNNING" }] });
  });

  it("keeps going when one operation throws (its lease lapses and the next tick retries)", async () => {
    rpc.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }], error: null });
    advanceOperation.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ status: "COMPLETED" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await onRequestPost({ env, request: req("s3cret") })).json();
    expect(body.results.map((r) => r.status)).toEqual(["ERROR", "COMPLETED"]);
  });

  it("calls autoReplaceFailedNodes and includes its result when FEATURE_AUTO_NODE_REPLACE is true", async () => {
    autoReplaceFailedNodes.mockResolvedValue([{ oldNodeId: "n1", newNodeId: "n1-r1", operationId: "op-9" }]);
    const res = await onRequestPost({
      env: { ...env, FEATURE_AUTO_NODE_REPLACE: "true" },
      request: req("s3cret"),
    });
    const body = await res.json();
    expect(autoReplaceFailedNodes).toHaveBeenCalled();
    expect(body.autoReplaced).toEqual([{ oldNodeId: "n1", newNodeId: "n1-r1", operationId: "op-9" }]);
  });

  it("does not call autoReplaceFailedNodes when the flag is unset", async () => {
    const res = await onRequestPost({ env, request: req("s3cret") });
    await res.json();
    expect(autoReplaceFailedNodes).not.toHaveBeenCalled();
  });

  it("does not fail the tick if autoReplaceFailedNodes throws", async () => {
    autoReplaceFailedNodes.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPost({ env: { ...env, FEATURE_AUTO_NODE_REPLACE: "true" }, request: req("s3cret") });
    expect(res.status).toBe(200);
  });

  it("calls autoScaleFullLocations and includes its result when FEATURE_AUTO_NODE_SCALE is true", async () => {
    autoScaleFullLocations.mockResolvedValue([{ locationId: "loc-1", role: "EXIT", newNodeId: "de-fsn-001-cap1", operationId: "op-9" }]);
    const res = await onRequestPost({
      env: { ...env, FEATURE_AUTO_NODE_SCALE: "true" },
      request: req("s3cret"),
    });
    const body = await res.json();
    expect(autoScaleFullLocations).toHaveBeenCalled();
    expect(body.autoScaled).toEqual([{ locationId: "loc-1", role: "EXIT", newNodeId: "de-fsn-001-cap1", operationId: "op-9" }]);
  });

  it("does not call autoScaleFullLocations when the flag is unset", async () => {
    const res = await onRequestPost({ env, request: req("s3cret") });
    await res.json();
    expect(autoScaleFullLocations).not.toHaveBeenCalled();
  });

  it("does not fail the tick if autoScaleFullLocations throws", async () => {
    autoScaleFullLocations.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPost({ env: { ...env, FEATURE_AUTO_NODE_SCALE: "true" }, request: req("s3cret") });
    expect(res.status).toBe(200);
  });

  // F-20/C-12: silence detection must run from fleet-tick itself every
  // minute, not only as a side effect of some other node's heartbeat or an
  // admin viewing the fleet page -- a single-node or fully-down fleet has
  // neither of those triggers.
  it("runs the silence-detection sweep every tick when FEATURE_AUTO_NODE_HEALTH is true", async () => {
    failSilentNodes.mockResolvedValue(["n1"]);
    const res = await onRequestPost({ env: { ...env, FEATURE_AUTO_NODE_HEALTH: "true" }, request: req("s3cret") });
    const body = await res.json();
    expect(failSilentNodes).toHaveBeenCalled();
    expect(body.silenceFailed).toEqual(["n1"]);
  });

  it("does not run the silence sweep when the flag is unset", async () => {
    await onRequestPost({ env, request: req("s3cret") });
    expect(failSilentNodes).not.toHaveBeenCalled();
  });

  it("does not fail the tick if the silence sweep throws", async () => {
    failSilentNodes.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPost({ env: { ...env, FEATURE_AUTO_NODE_HEALTH: "true" }, request: req("s3cret") });
    expect(res.status).toBe(200);
  });
});
