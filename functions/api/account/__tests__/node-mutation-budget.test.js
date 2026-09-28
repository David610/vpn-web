import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

/**
 * F-10 (P1): device add/remove and profile-assignment are node-affecting
 * mutations (the same vpn-admin -> sing-box reload-or-restart path that
 * drops every connection on the node) and must go through the same
 * checkNodeMutationBudget() gate that functions/api/vpn/rotate-credentials.js
 * already uses. These regression tests mirror
 * functions/api/vpn/__tests__/rotate-credentials.test.js's pattern: budget
 * enforced, 429 without enqueueing a job, existing happy-path behavior
 * unchanged.
 */

vi.mock("../../../lib/node-mutation-budget.js", () => ({
  checkNodeMutationBudget: vi.fn(),
}));

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { checkNodeMutationBudget } = await import("../../../lib/node-mutation-budget.js");
const { onRequestPost: addDevice } = await import("../devices.js");
const { onRequestPost: revokeDevice } = await import("../devices/[id]/revoke.js");
const { onRequestPost: assignProfile } = await import("../devices/[id]/assignment.js");

// LEGACY scheduling (no FEATURE_MULTI_NODE_SCHEDULING) always resolves to
// the fixed "node-1", per resolve-node.js -- keeps placement deterministic
// for these tests without needing fleet fixtures.
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function postReq(path, body) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seed({ devices = [], identities = [], subscriptionId = 1, extraSeats = 90 } = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ id: 1, account_id: "acct-1", user_id: "user-1", role: "owner" }],
      subscriptions: [
        {
          id: subscriptionId,
          account_id: "acct-1",
          status: "active",
          extra_seats: extraSeats,
          current_period_end: "2030-01-01T00:00:00.000Z",
        },
      ],
      devices,
      vpn_accounts: identities,
    },
    { user: { id: "user-1", email: "owner@example.com" } }
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  checkNodeMutationBudget.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/account/devices (add) node-mutation budget", () => {
  it("checks the budget for the node the device would be placed on and creates it when within budget", async () => {
    db = seed({ devices: [] });
    const res = await addDevice({ env, request: postReq("/api/account/devices", { name: "iPhone" }) });
    expect(res.status).toBe(201);
    expect(checkNodeMutationBudget).toHaveBeenCalledWith(expect.anything(), "acct-1", "node-1");
    expect(db._tables.devices).toHaveLength(1);
  });

  it("returns 429 and rolls back the device row once the node-mutation budget is exhausted", async () => {
    db = seed({ devices: [] });
    checkNodeMutationBudget.mockResolvedValue(false);
    const res = await addDevice({ env, request: postReq("/api/account/devices", { name: "iPhone" }) });
    expect(res.status).toBe(429);
    expect(db._tables.devices).toHaveLength(0);
    expect(db._tables.provisioning_jobs).toHaveLength(0);
  });
});

describe("POST /api/account/devices/:id/revoke node-mutation budget", () => {
  it("checks the budget for the identity's node and revokes when within budget", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [{ id: 1, device_id: "dev-1", user_id: "user-1", node_id: "node-1", vpn_user_id: "u1", enabled: true }],
    });
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-1/revoke"), params: { id: "dev-1" } });
    expect(res.status).toBe(200);
    expect(checkNodeMutationBudget).toHaveBeenCalledWith(expect.anything(), "acct-1", "node-1");
    expect(db._tables.devices[0].status).toBe("REVOKED");
  });

  it("returns 429 without revoking once the node-mutation budget is exhausted", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [{ id: 1, device_id: "dev-1", user_id: "user-1", node_id: "node-1", vpn_user_id: "u1", enabled: true }],
    });
    checkNodeMutationBudget.mockResolvedValue(false);
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-1/revoke"), params: { id: "dev-1" } });
    expect(res.status).toBe(429);
    expect(db._tables.devices[0].status).toBe("ACTIVE");
  });

  it("skips the budget check (and still revokes) when the device has no enabled identity yet", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [],
    });
    const res = await revokeDevice({ env, request: postReq("/api/account/devices/dev-1/revoke"), params: { id: "dev-1" } });
    expect(res.status).toBe(200);
    expect(checkNodeMutationBudget).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/devices/:id/assignment node-mutation budget", () => {
  it("checks the budget for the device's current node and reassigns when within budget", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [{ id: 1, device_id: "dev-1", user_id: "user-1", node_id: "node-1", vpn_user_id: "u1", enabled: true }],
    });
    db._tables.connection_profiles = [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }];
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(200);
    expect(checkNodeMutationBudget).toHaveBeenCalledWith(expect.anything(), "acct-1", "node-1");
  });

  it("returns 429 without upserting the assignment once the node-mutation budget is exhausted", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [{ id: 1, device_id: "dev-1", user_id: "user-1", node_id: "node-1", vpn_user_id: "u1", enabled: true }],
    });
    db._tables.connection_profiles = [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }];
    checkNodeMutationBudget.mockResolvedValue(false);
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(429);
  });

  it("skips the budget check (and still reassigns) when the device has no enabled identity yet", async () => {
    db = seed({
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", name: "iPhone", platform: "ios", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z", last_seen_at: null, subscription_id: 1 }],
      identities: [],
    });
    db._tables.connection_profiles = [{ id: "prof-1", account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "AUTO" }];
    const res = await assignProfile({
      env,
      request: postReq("/api/account/devices/dev-1/assignment", { profileId: "prof-1" }),
      params: { id: "dev-1" },
    });
    expect(res.status).toBe(200);
    expect(checkNodeMutationBudget).not.toHaveBeenCalled();
  });
});
