import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

const sendMemberInvite = vi.fn();
let db;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => db),
}));
vi.mock("../../../lib/resend.js", () => ({
  sendMemberInvite: (...args) => sendMemberInvite(...args),
}));

const { onRequestPost } = await import("../invites.js");

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  SITE_URL: "https://arcana.test",
  RESEND_API_KEY: "re_test",
};

function makeRequest(body) {
  return new Request("https://example.test/api/account/invites", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Owner of an account with a live subscription and `seatsTaken` members. */
function seed({ role = "owner", status = "active", extraSeats = 0, members = 1, invites = [] } = {}) {
  const account_members = [{ id: 1, account_id: "acct-1", user_id: "user-1", role }];
  for (let i = 2; i <= members; i += 1) {
    account_members.push({ id: i, account_id: "acct-1", user_id: `user-${i}`, role: "member" });
  }
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members,
      subscriptions: status
        ? [{ id: 1, account_id: "acct-1", status, extra_seats: extraSeats }]
        : [],
      member_invites: invites,
    },
    { user: { id: "user-1", email: "owner@example.com" } }
  );
}

beforeEach(() => {
  sendMemberInvite.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/account/invites", () => {
  it("creates an invite and emails a link, without returning the token", async () => {
    db = seed();
    const res = await onRequestPost({ env, request: makeRequest({ email: "New@Example.com" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    // The plaintext token belongs only in the invitee's inbox — possession
    // of the link is what proves they control that address.
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(body.invite.email).toBe("new@example.com");

    expect(db._tables.member_invites).toHaveLength(1);
    const stored = db._tables.member_invites[0];
    // Only the hash is persisted, and a SHA-256 hex digest is 64 chars.
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(sendMemberInvite).toHaveBeenCalledTimes(1);
    const sent = sendMemberInvite.mock.calls[0][1];
    expect(sent.to).toBe("new@example.com");
    expect(sent.acceptUrl).toMatch(/^https:\/\/arcana\.test\/invite\/\?token=/);
    // The emailed token must hash to the stored value and must not BE it.
    const emailedToken = decodeURIComponent(sent.acceptUrl.split("token=")[1]);
    expect(emailedToken).not.toBe(stored.token_hash);
  });

  it("refuses a member who is not the owner", async () => {
    db = seed({ role: "member" });
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(403);
    expect(db._tables.member_invites).toHaveLength(0);
  });

  it("refuses an account with no live subscription", async () => {
    db = seed({ status: null });
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/active subscription/) });
  });

  it("rejects a malformed email before writing anything", async () => {
    db = seed();
    const res = await onRequestPost({ env, request: makeRequest({ email: "not-an-email" }) });
    expect(res.status).toBe(400);
    expect(db._tables.member_invites).toHaveLength(0);
  });

  it("refuses once the included seats are taken", async () => {
    // 3 members on a 3-seat plan.
    db = seed({ members: 3 });
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "seats_full" });
  });

  it("counts a pending invite as a taken seat", async () => {
    // 2 members + 1 outstanding invite already fills a 3-seat plan, so the
    // owner cannot issue invites they have no room to honour.
    db = seed({
      members: 2,
      invites: [
        {
          id: 1,
          account_id: "acct-1",
          email: "pending@example.com",
          token_hash: "x".repeat(64),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
          accepted_at: null,
          revoked_at: null,
        },
      ],
    });
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(409);
  });

  it("allows a purchased extra seat past the included three", async () => {
    db = seed({ members: 3, extraSeats: 1 });
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(201);
  });

  it("re-inviting an address replaces its invite instead of taking a second seat", async () => {
    // Without revoking the old one this would violate
    // member_invites_pending_uniq; without discounting it from the seat
    // count a resend would look like it needed a seat it already holds.
    db = seed({
      members: 2,
      invites: [
        {
          id: 1,
          account_id: "acct-1",
          email: "pending@example.com",
          token_hash: "x".repeat(64),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
          accepted_at: null,
          revoked_at: null,
        },
      ],
    });
    const res = await onRequestPost({
      env,
      request: makeRequest({ email: "pending@example.com" }),
    });
    expect(res.status).toBe(201);

    const invites = db._tables.member_invites;
    expect(invites).toHaveLength(2);
    expect(invites[0].revoked_at).not.toBeNull();
    expect(invites[1].revoked_at ?? null).toBeNull();
    // The replacement carries a different token.
    expect(invites[1].token_hash).not.toBe(invites[0].token_hash);
  });

  it("still returns 201 when the invite email fails to send", async () => {
    // The row is committed by then; failing the request would leave the
    // owner unable to retry without tripping the one-live-invite index.
    db = seed();
    sendMemberInvite.mockRejectedValue(new Error("resend down"));
    const res = await onRequestPost({ env, request: makeRequest({ email: "new@example.com" }) });
    expect(res.status).toBe(201);
    // The seat is genuinely reserved, so reporting failure would be a lie —
    // and would leave the owner retrying against the one-live-invite index.
    expect(db._tables.member_invites).toHaveLength(1);
  });
});
