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

const startCreateNodeOperation = vi.fn();
// scheduler.js (imported by node-auto-scale.js for isUnderCapacity) itself
// imports CANARY_SESSION_CAP from fleet-operations.js -- mocking this module
// must keep that constant real, or isUnderCapacity's CANARY branch breaks.
vi.mock("../fleet-operations.js", () => ({ startCreateNodeOperation, CANARY_SESSION_CAP: 10 }));

// Dynamic import placed after the mocks/const above, matching the
// established pattern (node-auto-replace.test.js) for avoiding a TDZ
// ReferenceError against the mocked module's own const references.
const { autoScaleFullLocations, findCapacityExhaustedGroups, nextScaleNodeId } = await import(
  "../node-auto-scale.js"
);

describe("nextScaleNodeId (pure)", () => {
  it("appends -cap1 to a node id with no existing scale suffix", () => {
    expect(nextScaleNodeId("de-fsn-001")).toBe("de-fsn-001-cap1");
  });

  it("bumps an existing -capN suffix instead of doubling it", () => {
    expect(nextScaleNodeId("de-fsn-001-cap1")).toBe("de-fsn-001-cap2");
  });

  it("skips a -capN number already taken by a node from an earlier failed attempt", () => {
    expect(
      nextScaleNodeId("de-fsn-001", ["de-fsn-001", "de-fsn-001-cap1"])
    ).toBe("de-fsn-001-cap2");
  });

  it("finds the lowest unused number when several are taken", () => {
    expect(
      nextScaleNodeId("de-fsn-001", ["de-fsn-001-cap1", "de-fsn-001-cap2"])
    ).toBe("de-fsn-001-cap3");
  });
});

describe("findCapacityExhaustedGroups (pure)", () => {
  it("returns nothing when there are no nodes", () => {
    expect(findCapacityExhaustedGroups([])).toEqual([]);
  });

  it("flags a group whose only READY node is at max_sessions", () => {
    const nodes = [
      { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([
      { locationId: "loc-1", role: "EXIT", templateNode: nodes[0] },
    ]);
  });

  it("does not flag a group where at least one READY node has headroom", () => {
    const nodes = [
      { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" },
      { nodeId: "de-fsn-002", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 5, maxSessions: 100, lifecycleState: "READY" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([]);
  });

  it("does not flag a group with a scale-out already in flight (PROVISIONING)", () => {
    const nodes = [
      { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" },
      { nodeId: "de-fsn-001-cap1", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: null, maxSessions: null, lifecycleState: "PROVISIONING" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([]);
  });

  it("does not flag a group with a scale-out already in flight (WARMING_UP)", () => {
    const nodes = [
      { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" },
      { nodeId: "de-fsn-001-cap1", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 0, maxSessions: null, lifecycleState: "WARMING_UP" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([]);
  });

  it("ignores a group with no serving (READY/CANARY) nodes at all", () => {
    const nodes = [
      { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "FAILED" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([]);
  });

  it("respects a CANARY node's effective cap, not its raw max_sessions", () => {
    const nodes = [
      { nodeId: "de-fsn-canary", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 10, maxSessions: 1000, lifecycleState: "CANARY" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([
      { locationId: "loc-1", role: "EXIT", templateNode: nodes[0] },
    ]);
  });

  it("keeps groups independent per role within the same location", () => {
    const nodes = [
      { nodeId: "de-fsn-exit-1", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" },
      { nodeId: "de-fsn-relay-1", role: "RELAY", locationId: "loc-1", provider: "hetzner", configuredUsers: 5, maxSessions: 100, lifecycleState: "READY" },
    ];
    expect(findCapacityExhaustedGroups(nodes)).toEqual([
      { locationId: "loc-1", role: "EXIT", templateNode: nodes[0] },
    ]);
  });

  it("picks the lowest node_id as the template node, deterministically", () => {
    const nodeB = { nodeId: "de-fsn-002", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" };
    const nodeA = { nodeId: "de-fsn-001", role: "EXIT", locationId: "loc-1", provider: "hetzner", configuredUsers: 100, maxSessions: 100, lifecycleState: "READY" };
    expect(findCapacityExhaustedGroups([nodeB, nodeA])).toEqual([
      { locationId: "loc-1", role: "EXIT", templateNode: nodeA },
    ]);
  });
});

const baseEnv = {
  FEATURE_AUTO_NODE_SCALE: "true",
  FLEET_AUTO_SCALE_REGION: "fsn1",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0",
};

const FULL_NODE = {
  node_id: "de-fsn-001",
  role: "EXIT",
  location_id: "loc-1",
  provider: "hetzner",
  configured_users: 100,
  max_sessions: 100,
  lifecycle_state: "READY",
};

beforeEach(() => {
  startCreateNodeOperation.mockReset().mockResolvedValue({ operation: { id: "op-1" } });
});

describe("autoScaleFullLocations", () => {
  it("starts a CREATE_NODE operation for an exhausted (location, role) group", async () => {
    const db = makeFakeSupabase({ nodes: [FULL_NODE] });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([{ locationId: "loc-1", role: "EXIT", newNodeId: "de-fsn-001-cap1", operationId: "op-1" }]);
    expect(startCreateNodeOperation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        nodeId: "de-fsn-001-cap1",
        role: "EXIT",
        locationId: "loc-1",
        provider: "hetzner",
        region: "fsn1",
        hostname: "de-fsn-001-cap1.nodes.example.test",
      })
    );
  });

  it("does nothing when FEATURE_AUTO_NODE_SCALE is not enabled", async () => {
    const db = makeFakeSupabase({ nodes: [FULL_NODE] });
    const started = await autoScaleFullLocations(db, { ...baseEnv, FEATURE_AUTO_NODE_SCALE: "false" });
    expect(started).toEqual([]);
    expect(startCreateNodeOperation).not.toHaveBeenCalled();
  });

  it("no-ops without crashing when FLEET_AUTO_SCALE_REGION is not configured", async () => {
    const db = makeFakeSupabase({ nodes: [FULL_NODE] });
    const started = await autoScaleFullLocations(db, { ...baseEnv, FLEET_AUTO_SCALE_REGION: undefined });
    expect(started).toEqual([]);
    expect(startCreateNodeOperation).not.toHaveBeenCalled();
  });

  it("does not scale a location/role with headroom remaining", async () => {
    const db = makeFakeSupabase({
      nodes: [FULL_NODE, { ...FULL_NODE, node_id: "de-fsn-002", configured_users: 5 }],
    });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([]);
    expect(startCreateNodeOperation).not.toHaveBeenCalled();
  });

  it("does not scale a location/role that already has a scale-out in flight", async () => {
    const db = makeFakeSupabase({
      nodes: [FULL_NODE, { ...FULL_NODE, node_id: "de-fsn-001-cap1", lifecycle_state: "PROVISIONING", configured_users: null, max_sessions: null }],
    });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([]);
    expect(startCreateNodeOperation).not.toHaveBeenCalled();
  });

  it("skips a template node with no provider on record", async () => {
    const db = makeFakeSupabase({ nodes: [{ ...FULL_NODE, provider: null }] });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([]);
    expect(startCreateNodeOperation).not.toHaveBeenCalled();
  });

  it("swallows a 23505 (already started this tick) without logging an error result", async () => {
    startCreateNodeOperation.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const db = makeFakeSupabase({ nodes: [FULL_NODE] });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([]);
  });

  it("does not reuse a node id from an earlier scale-out attempt that failed", async () => {
    // de-fsn-001-cap1 already exists as FAILED -- not PROVISIONING/WARMING_UP,
    // so it does not block re-triggering (no scale-out is actually in
    // flight), but its id must not be proposed again for the new attempt.
    const db = makeFakeSupabase({
      nodes: [
        FULL_NODE,
        { node_id: "de-fsn-001-cap1", role: "EXIT", location_id: "loc-1", provider: "hetzner", configured_users: null, max_sessions: null, lifecycle_state: "FAILED" },
      ],
    });
    const started = await autoScaleFullLocations(db, baseEnv);
    expect(started).toEqual([{ locationId: "loc-1", role: "EXIT", newNodeId: "de-fsn-001-cap2", operationId: "op-1" }]);
    expect(startCreateNodeOperation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ nodeId: "de-fsn-001-cap2" })
    );
  });
});
