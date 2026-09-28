import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { reconcileFailedNodeAssignments } from "../fleet-operations.js";

function entitledRpc(entitled = true) {
  return {
    device_entitlement: () => ({ data: [{ entitled, subscription_id: entitled ? 1 : null, reason: null }], error: null }),
  };
}

function baseSeed() {
  return {
    nodes: [
      { node_id: "bad-node", role: "EXIT", lifecycle_state: "FAILED", configured_users: 0, max_sessions: 100 },
      { node_id: "good-node", role: "EXIT", lifecycle_state: "READY", configured_users: 5, max_sessions: 100 },
    ],
    devices: [{ id: "dev-1", user_id: "user-1" }],
    device_node_assignments: [{ device_id: "dev-1", node_id: "bad-node", hop: "EXIT" }],
    vpn_accounts: [{ id: 1, device_id: "dev-1", node_id: "bad-node", vpn_user_id: "vpn-1", enabled: true }],
    provisioning_jobs: [],
  };
}

describe("reconcileFailedNodeAssignments (F-20/B-03/C-12)", () => {
  it("enqueues a make-before-break CREATE_USER on a replacement node, without touching the assignment yet", async () => {
    const db = makeFakeSupabase(baseSeed(), { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([{ deviceId: "dev-1", oldNodeId: "bad-node", hop: "EXIT", status: "creating", targetNodeId: "good-node" }]);
    const jobs = db._tables.provisioning_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_type: "CREATE_USER", node_id: "good-node", device_id: "dev-1" });
    // Assignment must not move yet -- make-before-break.
    const assignment = db._tables.device_node_assignments.find((a) => a.device_id === "dev-1");
    expect(assignment.node_id).toBe("bad-node");
  });

  it("is idempotent: a second tick with the CREATE_USER already pending does not enqueue a duplicate", async () => {
    const seed = baseSeed();
    const db = makeFakeSupabase(seed, { rpc: entitledRpc(true) });
    await reconcileFailedNodeAssignments(db);
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([{ deviceId: "dev-1", oldNodeId: "bad-node", hop: "EXIT", status: "creating", targetNodeId: "good-node" }]);
    expect(db._tables.provisioning_jobs).toHaveLength(1);
  });

  it("once the new identity is enabled, switches the assignment and enqueues DISABLE_USER on the old node", async () => {
    const seed = baseSeed();
    seed.vpn_accounts.push({ id: 2, device_id: "dev-1", node_id: "good-node", vpn_user_id: "vpn-2", enabled: true });
    const db = makeFakeSupabase(seed, { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([{ deviceId: "dev-1", oldNodeId: "bad-node", hop: "EXIT", status: "reassigned", targetNodeId: "good-node" }]);

    const assignment = db._tables.device_node_assignments.find((a) => a.device_id === "dev-1");
    expect(assignment.node_id).toBe("good-node");

    const disableJob = db._tables.provisioning_jobs.find((j) => j.job_type === "DISABLE_USER");
    expect(disableJob).toMatchObject({ node_id: "bad-node", vpn_account_id: 1 });
  });

  it("skips a device whose entitlement has already lapsed", async () => {
    const db = makeFakeSupabase(baseSeed(), { rpc: entitledRpc(false) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([]);
    expect(db._tables.provisioning_jobs).toHaveLength(0);
  });

  it("reports no_replacement_available when every other node is over capacity or not READY/CANARY", async () => {
    const seed = baseSeed();
    seed.nodes[1].lifecycle_state = "DRAINING";
    const db = makeFakeSupabase(seed, { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([{ deviceId: "dev-1", oldNodeId: "bad-node", hop: "EXIT", status: "no_replacement_available" }]);
  });
});

describe("reconcileFailedNodeAssignments: DOUBLE_HOP RELAY-hop failover", () => {
  function doubleHopSeed() {
    return {
      nodes: [
        { node_id: "bad-relay", role: "RELAY", location_id: "loc-a", lifecycle_state: "FAILED", configured_users: 0, max_sessions: 100 },
        { node_id: "good-relay", role: "RELAY", location_id: "loc-a", lifecycle_state: "READY", configured_users: 5, max_sessions: 100 },
        { node_id: "exit-node", role: "EXIT", location_id: "loc-b", lifecycle_state: "READY", configured_users: 5, max_sessions: 100 },
      ],
      devices: [{ id: "dev-2", user_id: "user-2" }],
      device_node_assignments: [
        { device_id: "dev-2", node_id: "bad-relay", hop: "RELAY" },
        { device_id: "dev-2", node_id: "exit-node", hop: "EXIT" },
      ],
      vpn_accounts: [
        { id: 10, device_id: "dev-2", node_id: "bad-relay", vpn_user_id: "vpn-relay-1", enabled: true },
        { id: 11, device_id: "dev-2", node_id: "exit-node", vpn_user_id: "vpn-exit-1", enabled: true },
      ],
      provisioning_jobs: [],
    };
  }

  it("fails over a DOUBLE_HOP device's RELAY hop, not just its EXIT hop", async () => {
    const db = makeFakeSupabase(doubleHopSeed(), { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([
      { deviceId: "dev-2", oldNodeId: "bad-relay", hop: "RELAY", status: "creating", targetNodeId: "good-relay" },
    ]);
    const jobs = db._tables.provisioning_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ job_type: "CREATE_USER", node_id: "good-relay", device_id: "dev-2" });

    // The EXIT hop is healthy and must be untouched.
    const exitAssignment = db._tables.device_node_assignments.find(
      (a) => a.device_id === "dev-2" && a.hop === "EXIT"
    );
    expect(exitAssignment.node_id).toBe("exit-node");
  });

  it("only picks a RELAY replacement in the same location as the failed RELAY, never an EXIT node", async () => {
    const seed = doubleHopSeed();
    // A same-role, wrong-location RELAY must never be picked (would silently
    // break the device's scheduled entry/exit location pairing).
    seed.nodes.push({ node_id: "wrong-location-relay", role: "RELAY", location_id: "loc-z", lifecycle_state: "READY", configured_users: 0, max_sessions: 100 });
    const db = makeFakeSupabase(seed, { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results[0].targetNodeId).toBe("good-relay");
  });

  it("once the new RELAY identity is enabled, switches the RELAY assignment and enqueues DISABLE_USER on the old relay", async () => {
    const seed = doubleHopSeed();
    seed.vpn_accounts.push({ id: 12, device_id: "dev-2", node_id: "good-relay", vpn_user_id: "vpn-relay-2", enabled: true });
    const db = makeFakeSupabase(seed, { rpc: entitledRpc(true) });
    const results = await reconcileFailedNodeAssignments(db);
    expect(results).toEqual([
      { deviceId: "dev-2", oldNodeId: "bad-relay", hop: "RELAY", status: "reassigned", targetNodeId: "good-relay" },
    ]);

    const relayAssignment = db._tables.device_node_assignments.find(
      (a) => a.device_id === "dev-2" && a.hop === "RELAY"
    );
    expect(relayAssignment.node_id).toBe("good-relay");

    const disableJob = db._tables.provisioning_jobs.find((j) => j.job_type === "DISABLE_USER");
    expect(disableJob).toMatchObject({ node_id: "bad-relay", vpn_account_id: 10 });
  });
});
