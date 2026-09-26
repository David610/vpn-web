import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

const requireUser = vi.fn();
vi.mock("../../../lib/user-auth.js", () => ({ requireUser }));

let db;
vi.mock("../../../lib/account-http.js", () => ({ adminClient: vi.fn(() => db) }));

const authorizeRoute = vi.fn();
vi.mock("../../../lib/vpn-authorize.js", () => ({ authorizeRoute }));

const { onRequestPost } = await import("../authorize.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function req(body) {
  return new Request("https://arcana.example.test/v1/vpn/authorize", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ENTITLED_ENVELOPE = {
  ok: true,
  routeId: "de-fast",
  expiresAt: "2026-09-26T00:15:00.000Z",
  credentialEnvelope: { version: 1, hops: [{ uuid: "uuid-de-1" }] },
};

beforeEach(() => {
  requireUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, claims: { session_id: "sess-1" }, response: null });
  authorizeRoute.mockReset().mockResolvedValue(ENTITLED_ENVELOPE);
  db = makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }],
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", auth_session_id: "sess-1", subscription_id: 1, created_at: "2026-01-01T00:00:00.000Z" }],
    subscriptions: [{ id: 1, account_id: "acct-1", status: "active", extra_seats: 0, created_at: "2026-01-01T00:00:00.000Z" }],
  });
});

describe("POST /v1/vpn/authorize", () => {
  it("requires authentication, matching every other /v1 route", async () => {
    requireUser.mockResolvedValue({ user: null, claims: null, response: new Response(null, { status: 401 }) });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(401);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("rejects a missing route_id with 400 before touching the database", async () => {
    const res = await onRequestPost({ env, request: req({}) });
    expect(res.status).toBe(400);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("returns 409 not_entitled when the device has no live entitlement", async () => {
    db = makeFakeSupabase({
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      devices: [{ id: "dev-1", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", auth_session_id: "sess-1", subscription_id: null, created_at: "2026-01-01T00:00:00.000Z" }],
      subscriptions: [],
    });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("not_entitled");
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("returns the authorizeRoute envelope on success", async () => {
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      route_id: "de-fast",
      expires_at: "2026-09-26T00:15:00.000Z",
      credential_envelope: { version: 1, hops: [{ uuid: "uuid-de-1" }] },
    });
    expect(authorizeRoute).toHaveBeenCalledWith(
      db,
      env,
      expect.objectContaining({ routeId: "de-fast", device: expect.objectContaining({ id: "dev-1" }) })
    );
  });

  it("maps a failed authorizeRoute result to its status/message/code", async () => {
    authorizeRoute.mockResolvedValue({ ok: false, status: 503, message: "No server is currently available for this route." });
    const res = await onRequestPost({ env, request: req({ route_id: "de-fast" }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toBe("No server is currently available for this route.");
  });
});
