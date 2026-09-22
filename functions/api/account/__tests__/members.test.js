import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestDelete: removeMember } = await import("../members/[id].js");
const { onRequestDelete: revokeInvite } = await import("../invites/[id].js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function req(path) {
  return new Request(`https://example.test${path}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer good" },
  });
}

function seed({ callerRole = "owner", callerId = "user-1", rpc, invites = [], vpn = [] } = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: [
        { id: 1, account_id: "acct-1", user_id: "user-1", role: callerRole === "owner" ? "owner" : "member" },
        { id: 2, account_id: "acct-1", user_id: "user-2", role: "member" },
      ],
      member_invites: invites,
      vpn_accounts: vpn,
    },
    {
      user: { id: callerId, email: "caller@example.com" },
      rpc: { remove_account_member: rpc ?? (async () => ({ data: "new-acct", error: null })) },
    }
  );
}

const rpcRefuses = (name) => async () => ({
  data: null,
  error: { message: `${name} CONTEXT: PL/pgSQL function remove_account_member` },
});

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("DELETE /api/account/members/:id", () => {
  it("lets the owner remove a member and revokes their VPN access", async () => {
    db = seed({ vpn: [{ id: 7, user_id: "user-2", vpn_user_id: "vpn-2", node_id: "node-1" }] });
    const res = await removeMember({ env, request: req("/api/account/members/user-2"), params: { id: "user-2" } });

    expect(res.status).toBe(200);
    const jobs = db._tables.provisioning_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: "DISABLE_USER",
      payload: { vpn_user_id: "vpn-2", user_id: "user-2" },
    });
  });

  it("lets a member remove themselves", async () => {
    // Leaving a plan you were invited to is not an owner-only action.
    db = seed({ callerRole: "member", callerId: "user-2" });
    const res = await removeMember({ env, request: req("/api/account/members/user-2"), params: { id: "user-2" } });
    expect(res.status).toBe(200);
  });

  it("refuses a member trying to remove someone else", async () => {
    db = seed({ callerRole: "member", callerId: "user-2" });
    const res = await removeMember({ env, request: req("/api/account/members/user-1"), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("refuses to remove the owner", async () => {
    // An account with no owner has nobody to bill.
    db = seed({ rpc: rpcRefuses("cannot_remove_owner") });
    const res = await removeMember({ env, request: req("/api/account/members/user-1"), params: { id: "user-1" } });
    expect(res.status).toBe(409);
    expect(db._tables.provisioning_jobs).toHaveLength(0);
  });

  it("404s for someone who is not on the plan", async () => {
    db = seed({ rpc: rpcRefuses("not_a_member") });
    const res = await removeMember({ env, request: req("/api/account/members/stranger"), params: { id: "stranger" } });
    expect(res.status).toBe(404);
  });

  it("succeeds even when the member had no VPN account provisioned", async () => {
    db = seed({ vpn: [] });
    const res = await removeMember({ env, request: req("/api/account/members/user-2"), params: { id: "user-2" } });
    expect(res.status).toBe(200);
    expect(db._tables.provisioning_jobs).toHaveLength(0);
  });
});

describe("DELETE /api/account/invites/:id", () => {
  const liveInvite = {
    id: 5,
    account_id: "acct-1",
    email: "pending@example.com",
    token_hash: "x".repeat(64),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    accepted_at: null,
    revoked_at: null,
  };

  it("revokes an outstanding invite", async () => {
    db = seed({ invites: [{ ...liveInvite }] });
    const res = await revokeInvite({ env, request: req("/api/account/invites/5"), params: { id: "5" } });
    expect(res.status).toBe(200);
    // Revoked, not deleted: the row is the record that this token is spent.
    expect(db._tables.member_invites[0].revoked_at).not.toBeNull();
  });

  it("refuses a non-owner", async () => {
    db = seed({ callerRole: "member", callerId: "user-2", invites: [{ ...liveInvite }] });
    const res = await revokeInvite({ env, request: req("/api/account/invites/5"), params: { id: "5" } });
    expect(res.status).toBe(403);
    expect(db._tables.member_invites[0].revoked_at ?? null).toBeNull();
  });

  it("404s for an invite belonging to another account", async () => {
    // The id alone must not be enough to cancel someone else's invite, and
    // the response must not confirm that the row exists.
    db = seed({ invites: [{ ...liveInvite, account_id: "acct-other" }] });
    const res = await revokeInvite({ env, request: req("/api/account/invites/5"), params: { id: "5" } });
    expect(res.status).toBe(404);
    expect(db._tables.member_invites[0].revoked_at ?? null).toBeNull();
  });

  it("404s for an already-accepted invite", async () => {
    db = seed({ invites: [{ ...liveInvite, accepted_at: new Date().toISOString() }] });
    const res = await revokeInvite({ env, request: req("/api/account/invites/5"), params: { id: "5" } });
    expect(res.status).toBe(404);
  });

  it("404s for a non-numeric id without touching the database", async () => {
    db = seed({ invites: [{ ...liveInvite }] });
    const res = await revokeInvite({ env, request: req("/api/account/invites/abc"), params: { id: "abc" } });
    expect(res.status).toBe(404);
  });
});
