import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";

vi.mock("../provider-adapter.js", () => ({
  getProviderAdapter: vi.fn((provider) => {
    if (provider !== "hetzner") throw new Error(`Unknown or unsupported provider: ${provider}`);
    return { name: "hetzner" };
  }),
}));
vi.mock("../dns-adapter.js", () => ({
  getDnsAdapter: vi.fn(() => ({ name: "cloudflare" })),
  nodeHostname: vi.fn((nodeId) => `${nodeId}.nodes.example.test`),
}));

const startReplaceNodeOperation = vi.fn();
vi.mock("../fleet-operations.js", () => ({ startReplaceNodeOperation }));

// Dynamic import, placed after the mocks/consts above are set up: a static
// top-of-file import would be hoisted ahead of `startReplaceNodeOperation`'s
// own const declaration, so the mocked ../fleet-operations.js factory (run
// during this module's own import resolution) would reference it before
// initialization (TDZ). Matches the pattern already used in this plan's
// Task 4 route test.
const { autoReplaceFailedNodes } = await import("../node-auto-replace.js");

const baseEnv = {
  FLEET_AUTO_REPLACE_REGION: "fsn1",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0",
  AUTO_REPLACE_AFTER_FAILED_MS: String(60 * 60 * 1000),
};

const OLD = {
  node_id: "de-fsn-001",
  role: "EXIT",
  location_id: "loc-1",
  provider: "hetzner",
  lifecycle_state: "FAILED",
  lifecycle_state_changed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  startReplaceNodeOperation.mockReset().mockResolvedValue({ operation: { id: "op-1" } });
});

describe("autoReplaceFailedNodes", () => {
  it("starts a replacement for a node FAILED longer than the threshold", async () => {
    const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([{ oldNodeId: "de-fsn-001", newNodeId: "de-fsn-001-r1", operationId: "op-1" }]);
    expect(startReplaceNodeOperation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ oldNodeId: "de-fsn-001", newNodeId: "de-fsn-001-r1", provider: "hetzner", region: "fsn1" })
    );
  });

  it("skips a node FAILED for less than the threshold", async () => {
    const recent = { ...OLD, lifecycle_state_changed_at: new Date().toISOString() };
    const db = makeFakeSupabase({ nodes: [recent], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("skips a node that already has a REPLACE_NODE operation", async () => {
    const db = makeFakeSupabase({
      nodes: [OLD],
      fleet_operations: [{ id: "op-existing", type: "REPLACE_NODE", idempotency_key: "REPLACE_NODE:de-fsn-001" }],
    });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("no-ops without crashing when FLEET_AUTO_REPLACE_REGION is not configured", async () => {
    const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, { ...baseEnv, FLEET_AUTO_REPLACE_REGION: undefined });
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("skips a node with no provider on record", async () => {
    const noProvider = { ...OLD, provider: null };
    const db = makeFakeSupabase({ nodes: [noProvider], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });
});
