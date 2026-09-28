import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateUserById = vi.fn();
const signOut = vi.fn();
const getClaims = vi.fn();

const db = {
  auth: {
    getClaims,
    admin: { updateUserById, signOut },
  },
};

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestPost } = await import("../password.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest({ password = "correct horse battery staple 123", token = "current-access-token" } = {}) {
  return new Request("https://example.test/api/account/password", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  updateUserById.mockReset();
  signOut.mockReset();
  getClaims.mockReset();
  updateUserById.mockResolvedValue({ error: null });
  signOut.mockResolvedValue({ error: null });
  const nowSeconds = Math.floor(Date.now() / 1000);
  getClaims.mockResolvedValue({
    data: {
      claims: {
        sub: "user-1",
        email: "user@example.com",
        amr: [{ method: "password", timestamp: nowSeconds }],
      },
    },
    error: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/account/password", () => {
  // F-22: changing a password should not leave a stolen session alive
  // elsewhere. admin.signOut with scope "others" revokes every session for
  // this user except the one making the request.
  it("signs out every other session using the caller's own access token", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ token: "current-access-token" }) });
    expect(res.status).toBe(200);
    expect(updateUserById).toHaveBeenCalledWith("user-1", {
      password: "correct horse battery staple 123",
    });
    expect(signOut).toHaveBeenCalledWith("current-access-token", "others");
  });

  it("still reports success if revoking other sessions fails, since the password change itself succeeded", async () => {
    signOut.mockResolvedValue({ error: { message: "gotrue down" } });
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("does not update the password when it fails validation", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ password: "short" }) });
    expect(res.status).toBe(400);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});
