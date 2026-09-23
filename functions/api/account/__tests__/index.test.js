import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet } = await import("../index.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/account", {
    headers: { Authorization: "Bearer good" },
  });
}

const future = () => new Date(Date.now() + 86400_000).toISOString();
const past = () => new Date(Date.now() - 86400_000).toISOString();

function seed({
  callerId = "user-1",
  role = "owner",
  status = "active",
  extraSeats = 0,
  members = [{ id: "user-1", role: "owner" }],
  invites = [],
} = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: members.map((m, i) => ({
        id: i + 1,
        account_id: "acct-1",
        user_id: m.id,
        role: m.role,
        created_at: "2026-01-01T00:00:00Z",
      })),
      subscriptions: status
        ? [
            {
              id: 1,
              account_id: "acct-1",
              status,
              current_period_end: "2030-01-01T00:00:00Z",
              cancel_at_period_end: false,
              extra_seats: extraSeats,
            },
          ]
        : [],
      member_invites: invites,
    },
    {
      user: { id: callerId, email: "owner@example.com" },
      users: members.map((m) => ({ id: m.id, email: `${m.id}@example.com` })),
    }
  );
}

function liveInvite(id, email) {
  return {
    id,
    account_id: "acct-1",
    email,
    token_hash: String(id).repeat(64).slice(0, 64),
    expires_at: future(),
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GET /api/account", () => {
  it("reports the owner, their seats and no invites", async () => {
    db = seed();
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.role).toBe("owner");
    expect(body.seats).toEqual({ included: 3, extra: 0, limit: 3, used: 1, available: 2 });
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ userId: "user-1", role: "owner", isYou: true });
  });

  it("counts a pending invite as a used seat", async () => {
    // Otherwise an owner could issue invites they have no room to honour and
    // only find out when someone tries to accept.
    db = seed({ invites: [liveInvite(1, "pending@example.com")] });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.seats).toMatchObject({ used: 2, available: 1 });
    expect(body.invites).toHaveLength(1);
  });

  it("raises the limit by purchased extra seats", async () => {
    db = seed({ extraSeats: 2 });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.seats).toMatchObject({ included: 3, extra: 2, limit: 5, available: 4 });
  });

  it("never reports negative availability when a plan is over-subscribed", async () => {
    // Possible if extra seats are dropped at renewal while members remain.
    db = seed({
      members: [
        { id: "user-1", role: "owner" },
        { id: "user-2", role: "member" },
        { id: "user-3", role: "member" },
        { id: "user-4", role: "member" },
      ],
    });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.seats).toMatchObject({ limit: 3, used: 4, available: 0 });
  });

  it("omits spent, withdrawn and expired invites", async () => {
    // Each of these is inert; listing them would let the client mistake one
    // for something still usable, and each would inflate the seat count.
    db = seed({
      invites: [
        { ...liveInvite(1, "accepted@example.com"), accepted_at: past() },
        { ...liveInvite(2, "revoked@example.com"), revoked_at: past() },
        { ...liveInvite(3, "expired@example.com"), expires_at: past() },
        liveInvite(4, "live@example.com"),
      ],
    });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].email).toBe("live@example.com");
    expect(body.seats.used).toBe(2);
  });

  it("never exposes an invite token hash", async () => {
    db = seed({ invites: [liveInvite(1, "pending@example.com")] });
    const res = await onRequestGet({ env, request: makeRequest() });
    const raw = await res.text();
    expect(raw).not.toMatch(/token/i);
  });

  it("sorts the owner first and marks the caller", async () => {
    db = seed({
      callerId: "user-2",
      members: [
        { id: "user-2", role: "member" },
        { id: "user-1", role: "owner" },
      ],
    });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.members[0].role).toBe("owner");
    expect(body.members.find((m) => m.userId === "user-2").isYou).toBe(true);
    expect(body.role).toBe("member");
  });

  it("returns a null subscription for an unbilled account", async () => {
    db = seed({ status: null });
    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.subscription).toBeNull();
    // Still 3 included seats, just nothing to share yet.
    expect(body.seats).toMatchObject({ limit: 3, extra: 0 });
  });

  it("500s rather than inventing an account when membership is missing", async () => {
    db = seed({ members: [] });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(500);
  });
});
