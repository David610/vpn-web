import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet: listDevices } = await import("../devices.js");
const { onRequestGet: listProfiles } = await import("../connection-profiles.js");
const { onRequestPost: revokeDevice } = await import("../devices/[id]/revoke.js");
const { onRequestPost: assignProfile } = await import("../devices/[id]/assignment.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function getReq(path) {
  return new Request(`https://example.test${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer good" },
  });
}

function postReq(path, body) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seed({
  callerId = "user-1",
  devices = [],
  profiles = [],
  assignments = [],
} = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ id: 1, account_id: "acct-1", user_id: "user-1", role: "owner" }],
      devices,
      connection_profiles: profiles,
      device_profile_assignments: assignments,
    },
    { user: { id: callerId, email: "caller@example.com" } }
  );
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GET /api/account/devices", () => {
  it("lists the account's devices with their current profile assignment", async () => {
    db = seed({
      devices: [
        { id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "Legacy device", platform: null, status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null },
        { id: "dev-2", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-02T00:00:00Z", last_seen_at: null },
      ],
      profiles: [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }],
      assignments: [{ device_id: "dev-1", profile_id: "prof-1", assigned_at: "2026-01-03T00:00:00Z" }],
    });

    const res = await listDevices({ env, request: getReq("/api/account/devices") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    const dev1 = body.devices.find((d) => d.id === "dev-1");
    expect(dev1.assignment).toMatchObject({ profileId: "prof-1" });
    expect(dev1.assignment.profile).toMatchObject({ name: "Fast", routingMode: "AUTO" });
    expect(dev1.assignment.profile.routing_mode).toBeUndefined();
    const dev2 = body.devices.find((d) => d.id === "dev-2");
    expect(dev2.assignment).toBeNull();
  });

  it("never returns another account's devices", async () => {
    db = seed({
      devices: [
        { id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "Mine", platform: null, status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null },
        { id: "dev-9", account_id: "acct-other", user_id: "user-9", name: "Not mine", platform: null, status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null },
      ],
    });
    const res = await listDevices({ env, request: getReq("/api/account/devices") });
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].id).toBe("dev-1");
  });
});

describe("GET /api/account/connection-profiles", () => {
  it("lists the account's connection profiles", async () => {
    db = seed({
      profiles: [
        { id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO", preferred_entry_location_id: null, preferred_exit_location_id: null, auto_failover: true },
        { id: "prof-9", account_id: "acct-other", name: "Other", enabled: true, routing_mode: "AUTO", preferred_entry_location_id: null, preferred_exit_location_id: null, auto_failover: true },
      ],
    });
    const res = await listProfiles({ env, request: getReq("/api/account/connection-profiles") });
    const body = await res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].id).toBe("prof-1");
  });
});

describe("POST /api/account/devices/:id/revoke", () => {
  it("revokes an active device the caller owns", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
    });
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-1/revoke"), params: { id: "dev-1" } });
    expect(res.status).toBe(200);
    expect(db._tables.devices[0].status).toBe("REVOKED");
  });

  it("404s for a device belonging to another account", async () => {
    db = seed({
      devices: [{ id: "dev-9", account_id: "acct-other", user_id: "user-9", name: "Not mine", platform: null, status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
    });
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-9/revoke"), params: { id: "dev-9" } });
    expect(res.status).toBe(404);
    expect(db._tables.devices[0].status).toBe("ACTIVE");
  });

  it("404s for a nonexistent device", async () => {
    db = seed({});
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/nope/revoke"), params: { id: "nope" } });
    expect(res.status).toBe(404);
  });

  it("409s when the device is already revoked", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "REVOKED", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
    });
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-1/revoke"), params: { id: "dev-1" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/account/devices/:id/assignment", () => {
  it("assigns a profile to a device with no prior assignment", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(200);
    expect(db._tables.device_profile_assignments).toHaveLength(1);
    expect(db._tables.device_profile_assignments[0]).toMatchObject({ device_id: "dev-1", profile_id: "prof-1" });
  });

  it("reassigns (upserts) a device that already has a profile", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [
        { id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" },
        { id: "prof-2", account_id: "acct-1", name: "Private", enabled: true, routing_mode: "AUTO" },
      ],
      assignments: [{ device_id: "dev-1", profile_id: "prof-1", assigned_at: "2026-01-01T00:00:00Z" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-2" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(200);
    expect(db._tables.device_profile_assignments).toHaveLength(1);
    expect(db._tables.device_profile_assignments[0].profile_id).toBe("prof-2");
  });

  it("refuses a profile belonging to another account with a clean 403", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [{ id: "prof-9", account_id: "acct-other", name: "Other", enabled: true, routing_mode: "AUTO" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-9" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(403);
    expect(db._tables.device_profile_assignments).toHaveLength(0);
  });

  it("404s for a device belonging to another account", async () => {
    db = seed({
      devices: [{ id: "dev-9", account_id: "acct-other", user_id: "user-9", name: "Not mine", platform: null, status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-9/assignment", { profileId: "prof-1" }),
      params: { id: "dev-9" },
    });
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent profile", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "nope" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(404);
  });

  it("400s when assigning a disabled profile", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: false, routing_mode: "AUTO" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(400);
    expect(db._tables.device_profile_assignments).toHaveLength(0);
  });

  it("400s on a missing profileId", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", {}),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(400);
  });

  it("409s when assigning to a revoked device", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "REVOKED", created_at: "2026-01-01T00:00:00Z", last_seen_at: null }],
      profiles: [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }],
    });
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(409);
  });
});
