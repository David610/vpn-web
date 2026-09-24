import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestPost } = await import("../accept-invite.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body = { token: "plaintext-token" }) {
  return new Request("https://example.test/api/account/accept-invite", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** @param rpc what accept_member_invite should do this time. */
function seed(rpc, { status = "active", periodEnd = "2030-01-01T00:00:00Z" } = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      subscriptions: status
        ? [{ id: 1, account_id: "acct-1", status, current_period_end: periodEnd, extra_seats: 0 }]
        : [],
    },
    { user: { id: "invitee-1", email: "invitee@example.com" }, rpc: { accept_member_invite: rpc } }
  );
}

// Faithful to the real RPC: accepting commits the membership row.
const ok = async (args, tables) => {
  if (!tables.account_members.some((m) => m.user_id === args.p_user_id)) {
    tables.account_members.push({ account_id: "acct-1", user_id: args.p_user_id, role: "member" });
  }
  return { data: "acct-1", error: null };
};
const refuses = (name) => async () => ({
  data: null,
  error: { message: `${name} CONTEXT: PL/pgSQL function accept_member_invite` },
});

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("POST /api/account/accept-invite", () => {
  it("hashes the token before it reaches the database", async () => {
    db = seed(ok);
    await onRequestPost({ env, request: makeRequest({ token: "plaintext-token" }) });

    const [, args] = db.rpc.mock.calls[0];
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext must never be what we look up by — the column stores a
    // digest, and a database dump must not yield usable invites.
    expect(args.p_token_hash).not.toBe("plaintext-token");
    expect(args.p_user_id).toBe("invitee-1");
  });

  it("enqueues provisioning for the new member on a billed plan", async () => {
    db = seed(ok);
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(200);

    // The new member gets their own device, and the job creates that
    // device's identity -- never a credential shared with anyone else.
    const devices = db._tables.devices.filter((d) => d.user_id === "invitee-1");
    expect(devices).toHaveLength(1);
    const jobs = db._tables.provisioning_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: "CREATE_USER",
      device_id: devices[0].id,
      payload: { user_id: "invitee-1", device_id: devices[0].id, expires_at: "2030-01-01T00:00:00Z" },
    });
  });

  it("does not enqueue twice if acceptance is retried", async () => {
    db = seed(ok);
    await onRequestPost({ env, request: makeRequest() });
    await onRequestPost({ env, request: makeRequest() });
    expect(db._tables.provisioning_jobs).toHaveLength(1);
    expect(db._tables.devices.filter((d) => d.user_id === "invitee-1")).toHaveLength(1);
  });

  it("still succeeds when provisioning cannot be enqueued", async () => {
    // The membership is already committed by the RPC; failing here would
    // spend the invite with no way for the invitee to retry.
    db = seed(ok);
    db.from = vi.fn((table) => {
      if (table === "provisioning_jobs") {
        return { insert: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } }) };
      }
      return makeFakeSupabase({
        subscriptions: [{ id: 1, account_id: "acct-1", status: "active", current_period_end: "2030-01-01T00:00:00Z" }],
      }).from(table);
    });
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(200);
  });

  it.each([
    ["invite_not_found", 404],
    ["invite_already_accepted", 409],
    ["invite_revoked", 409],
    ["invite_expired", 410],
    ["invite_email_unverified", 403],
    ["invite_email_mismatch", 403],
    ["invite_acceptor_missing", 403],
    ["seats_full", 409],
    ["already_member", 409],
    ["has_own_subscription", 409],
    ["owns_shared_account", 409],
  ])("maps %s to HTTP %i", async (name, status) => {
    db = seed(refuses(name));
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: name });
    expect(db._tables.provisioning_jobs).toHaveLength(0);
  });

  it("returns 500 rather than a misleading message for an unrecognised failure", async () => {
    db = seed(refuses("some_unexpected_pg_error"));
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(500);
  });

  it("rejects a missing token without calling the database", async () => {
    db = seed(ok);
    const res = await onRequestPost({ env, request: makeRequest({}) });
    expect(res.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
