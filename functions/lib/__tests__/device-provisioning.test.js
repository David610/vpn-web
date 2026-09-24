import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import {
  reconcileDeviceProvisioning,
  reconcileAccountProvisioning,
  revokeDevice,
} from "../device-provisioning.js";
import { finalizeCreatedIdentity } from "../identity-lifecycle.js";

const LEGACY = {};
const FLEET = { FEATURE_MULTI_NODE_SCHEDULING: "true" };
const PAID = { source: "stripe", serviceExpiresAt: "2030-01-01T00:00:00.000Z", clearExpiry: false };

const DE = "11111111-1111-4111-8111-111111111111";
const FI = "22222222-2222-4222-8222-222222222222";
const NL = "33333333-3333-4333-8333-333333333333";

function node(node_id, location_id, extra = {}) {
  return { node_id, location_id, role: "EXIT", lifecycle_state: "READY", configured_users: 0, max_sessions: null, ...extra };
}

function world({ nodes = [], paths = [], profile = null, identities = [], deviceStatus = "ACTIVE" } = {}) {
  const device = { id: "dev-1", account_id: "acct-1", user_id: "user-1", status: deviceStatus };
  return {
    device,
    db: makeFakeSupabase({
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      devices: [{ ...device, name: "Phone" }],
      nodes,
      allowed_paths: paths,
      connection_profiles: profile ? [{ id: "prof-1", account_id: "acct-1", enabled: true, ...profile }] : [],
      device_profile_assignments: profile ? [{ device_id: "dev-1", profile_id: "prof-1" }] : [],
      vpn_accounts: identities.map((i, n) => ({ id: n + 1, user_id: "user-1", device_id: "dev-1", enabled: true, ...i })),
    }),
  };
}

const jobs = (db) => db._tables.provisioning_jobs;
const devRow = (db) => db._tables.devices[0];
const directPath = (loc) => ({ id: `p-${loc}`, entry_location_id: null, exit_location_id: loc, enabled: true });

describe("legacy single-node account (FEATURE_MULTI_NODE_SCHEDULING off)", () => {
  it("places every device on node-1, ignoring fleet nodes and profiles", async () => {
    const { db, device } = world({
      nodes: [node("de-fsn-001", DE)],
      paths: [directPath(DE)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
    });
    const r = await reconcileDeviceProvisioning(db, LEGACY, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.action).toBe("creating");
    expect(jobs(db)).toEqual([
      expect.objectContaining({ job_type: "CREATE_USER", node_id: "node-1", device_id: "dev-1" }),
    ]);
  });

  it("keeps an existing node-1 identity: renewal = one SET_EXPIRY, no ENABLE churn", async () => {
    const { db, device } = world({ identities: [{ node_id: "node-1", vpn_user_id: "vpn-1" }] });
    await reconcileDeviceProvisioning(db, LEGACY, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(jobs(db).map((j) => [j.job_type, j.node_id])).toEqual([["SET_EXPIRY", "node-1"]]);
  });
});

describe("fleet account (FEATURE_MULTI_NODE_SCHEDULING on)", () => {
  it("DIRECT: schedules a READY exit in the chosen location and creates the identity there", async () => {
    const { db, device } = world({
      nodes: [node("de-fsn-001", DE, { configured_users: 40 }), node("de-fsn-002", DE, { configured_users: 3 }), node("fi-hel-001", FI)],
      paths: [directPath(DE), directPath(FI)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement).toMatchObject({ ok: true, mode: "DIRECT", entryNodeId: "de-fsn-002" });
    expect(jobs(db)).toEqual([expect.objectContaining({ job_type: "CREATE_USER", node_id: "de-fsn-002" })]);
    expect(devRow(db)).toMatchObject({ placement_status: "PLACED", placement_error: null });
    expect(db._tables.device_node_assignments).toEqual([
      expect.objectContaining({ device_id: "dev-1", node_id: "de-fsn-002", hop: "EXIT" }),
    ]);
  });

  it("DIRECT: never schedules a node that is not READY, is a RELAY, or is at capacity", async () => {
    const { db, device } = world({
      nodes: [
        node("de-drain", DE, { lifecycle_state: "DRAINING" }),
        node("de-failed", DE, { lifecycle_state: "FAILED" }),
        node("de-relay", DE, { role: "RELAY" }),
        node("de-full", DE, { configured_users: 100, max_sessions: 100 }),
      ],
      paths: [directPath(DE)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement).toMatchObject({ ok: false, kind: "CAPACITY" });
    expect(jobs(db)).toHaveLength(0);
    expect(devRow(db)).toMatchObject({ placement_status: "UNSCHEDULABLE" });
  });

  it("fails CLOSED on a route that is not allowed: no fallback to node-1, existing identity disabled", async () => {
    const { db, device } = world({
      nodes: [node("de-fsn-001", DE)],
      paths: [{ ...directPath(DE), enabled: false }],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
      identities: [{ node_id: "node-1", vpn_user_id: "vpn-old" }],
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement).toMatchObject({ ok: false, kind: "POLICY" });
    expect(jobs(db).map((j) => [j.job_type, j.node_id])).toEqual([["DISABLE_USER", "node-1"]]);
    expect(jobs(db).some((j) => j.job_type === "CREATE_USER")).toBe(false);
  });

  it("keeps existing identities (no jobs) when the location merely has no healthy node right now", async () => {
    const { db, device } = world({
      nodes: [node("de-fsn-001", DE, { lifecycle_state: "FAILED" })],
      paths: [directPath(DE)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
      identities: [{ node_id: "de-fsn-001", vpn_user_id: "vpn-1" }],
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement.kind).toBe("CAPACITY");
    expect(jobs(db)).toHaveLength(0);
  });

  it("DOUBLE_HOP: the identity lives on the RELAY; both hops are sticky-assigned", async () => {
    const { db, device } = world({
      nodes: [node("fi-hel-r1", FI, { role: "RELAY" }), node("de-fsn-001", DE)],
      paths: [{ id: "p-fi-de", entry_location_id: FI, exit_location_id: DE, enabled: true }],
      profile: { routing_mode: "DOUBLE_HOP", preferred_entry_location_id: FI, preferred_exit_location_id: DE },
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement).toMatchObject({ ok: true, entryNodeId: "fi-hel-r1", exitNodeId: "de-fsn-001" });
    expect(jobs(db)).toEqual([expect.objectContaining({ job_type: "CREATE_USER", node_id: "fi-hel-r1" })]);
    expect(db._tables.device_node_assignments.map((a) => [a.hop, a.node_id]).sort()).toEqual([
      ["EXIT", "de-fsn-001"],
      ["RELAY", "fi-hel-r1"],
    ]);
  });

  it("DOUBLE_HOP: an entry/exit pair with no allowed path is refused even if both nodes exist", async () => {
    const { db, device } = world({
      nodes: [node("nl-ams-r1", NL, { role: "RELAY" }), node("de-fsn-001", DE)],
      paths: [{ id: "p-fi-de", entry_location_id: FI, exit_location_id: DE, enabled: true }],
      profile: { routing_mode: "DOUBLE_HOP", preferred_entry_location_id: NL, preferred_exit_location_id: DE },
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement.kind).toBe("POLICY");
    expect(jobs(db)).toHaveLength(0);
  });

  it("AUTO (no profile): a legacy device already on an eligible node stays put", async () => {
    const { db, device } = world({
      nodes: [node("node-1", DE, { configured_users: 90 }), node("de-fsn-002", DE, { configured_users: 1 })],
      paths: [directPath(DE)],
      identities: [{ node_id: "node-1", vpn_user_id: "vpn-1" }],
    });
    const r = await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(r.placement.entryNodeId).toBe("node-1");
    expect(jobs(db).map((j) => j.job_type)).toEqual(["SET_EXPIRY"]);
  });

  it("moves make-before-break: creates on the new node first, disables the old one only once it exists", async () => {
    const { db, device } = world({
      nodes: [node("fi-hel-001", FI), node("de-fsn-001", DE)],
      paths: [directPath(FI), directPath(DE)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
      identities: [{ node_id: "fi-hel-001", vpn_user_id: "vpn-fi" }],
    });
    await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "t" });
    expect(jobs(db).map((j) => [j.job_type, j.node_id])).toEqual([["CREATE_USER", "de-fsn-001"]]);

    // The DE node reports the identity created -> the FI identity goes.
    db._tables.vpn_accounts.push({ id: 2, user_id: "user-1", device_id: "dev-1", node_id: "de-fsn-001", vpn_user_id: "vpn-de", enabled: true });
    await finalizeCreatedIdentity(db, {
      identity: { id: 2, deviceId: "dev-1", vpnUserId: "vpn-de" },
      nodeId: "de-fsn-001",
      userId: "user-1",
    });
    expect(jobs(db).slice(1).map((j) => [j.job_type, j.node_id, j.vpn_account_id])).toEqual([
      ["DISABLE_USER", "fi-hel-001", 1],
    ]);
  });

  it("never enqueues two in-flight creates for one device/node, even from different events", async () => {
    const { db, device } = world({
      nodes: [node("de-fsn-001", DE)],
      paths: [directPath(DE)],
      profile: { routing_mode: "DIRECT", preferred_exit_location_id: DE },
    });
    await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "event-a" });
    await reconcileDeviceProvisioning(db, FLEET, { device, entitlement: PAID, idempotencyPrefix: "event-b" });
    expect(jobs(db).filter((j) => j.job_type === "CREATE_USER")).toHaveLength(1);
  });
});

describe("device revocation removes real network access", () => {
  it("disables every identity of the device, on each identity's own node", async () => {
    const { db, device } = world({
      identities: [
        { node_id: "node-1", vpn_user_id: "vpn-a" },
        { node_id: "de-fsn-001", vpn_user_id: "vpn-b" },
        { node_id: "fi-hel-001", vpn_user_id: "vpn-c", enabled: false },
      ],
    });
    const r = await revokeDevice(db, FLEET, device, "rev");
    expect(r).toEqual({ revoked: true, disabled: 2 });
    expect(devRow(db).status).toBe("REVOKED");
    expect(jobs(db).map((j) => [j.job_type, j.node_id]).sort()).toEqual([
      ["DISABLE_USER", "de-fsn-001"],
      ["DISABLE_USER", "node-1"],
    ]);
  });

  it("an identity whose CREATE raced a revocation is disabled the moment it is reported", async () => {
    const { db } = world({ deviceStatus: "REVOKED" });
    db._tables.vpn_accounts.push({ id: 5, user_id: "user-1", device_id: "dev-1", node_id: "de-fsn-001", vpn_user_id: "vpn-late", enabled: true });
    const r = await finalizeCreatedIdentity(db, {
      identity: { id: 5, deviceId: "dev-1", vpnUserId: "vpn-late" },
      nodeId: "de-fsn-001",
      userId: "user-1",
    });
    expect(r.disabledNew).toBe(true);
    expect(jobs(db)).toEqual([
      expect.objectContaining({ job_type: "DISABLE_USER", node_id: "de-fsn-001", vpn_account_id: 5 }),
    ]);
  });

  it("billing never resurrects a revoked device or gives its member a fresh one", async () => {
    const { db } = world({ deviceStatus: "REVOKED", identities: [{ node_id: "node-1", vpn_user_id: "vpn-1", enabled: false }] });
    await reconcileAccountProvisioning(db, LEGACY, {
      accountId: "acct-1",
      members: [{ userId: "user-1", role: "owner" }],
      entitlement: PAID,
      idempotencyPrefix: "renewal",
    });
    expect(db._tables.devices).toHaveLength(1);
    expect(jobs(db).filter((j) => j.job_type !== "DISABLE_USER")).toHaveLength(0);
  });
});
