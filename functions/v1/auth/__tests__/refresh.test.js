import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshGrant = vi.fn();
const checkRateLimit = vi.fn();
const adminClientMock = { marker: "admin-client" };

vi.mock("../../../lib/gotrue.js", () => ({
  AuthRejected: class AuthRejected extends Error {},
  refreshGrant: (...args) => refreshGrant(...args),
  sessionIdOf: () => "sess-1",
}));
vi.mock("../../../lib/account-http.js", () => ({
  adminClient: () => adminClientMock,
}));
vi.mock("../../../lib/rate-limit.js", () => ({
  checkRateLimit: (...args) => checkRateLimit(...args),
  rateLimitedResponse: (message) =>
    new Response(JSON.stringify({ error: message }), { status: 429, headers: { "Content-Type": "application/json" } }),
  clientIpKey: () => "1.2.3.4",
}));

const { onRequestPost } = await import("../refresh.js");
const env = {};

function makeRequest(body) {
  return new Request("https://example.test/v1/auth/refresh", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  refreshGrant.mockReset().mockResolvedValue({ access_token: "at", user: { id: "user-1" } });
  checkRateLimit.mockReset().mockResolvedValue(true);
});

describe("POST /v1/auth/refresh rate limiting (F-13)", () => {
  it("checks both the hashed-token and IP buckets before calling GoTrue", async () => {
    await onRequestPost({ env, request: makeRequest({ refresh_token: "rt-secret" }) });
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, expect.stringMatching(/^v1-refresh:token:[0-9a-f]{64}$/), expect.any(Object));
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, "v1-refresh:ip:1.2.3.4", expect.any(Object));
    expect(refreshGrant).toHaveBeenCalled();
  });

  it("never puts the raw refresh token in the rate-limit key", async () => {
    await onRequestPost({ env, request: makeRequest({ refresh_token: "super-secret-token" }) });
    const keys = checkRateLimit.mock.calls.map((c) => c[1]);
    expect(keys.some((k) => k.includes("super-secret-token"))).toBe(false);
  });

  it("returns 429 and never calls GoTrue when the token bucket is exhausted", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("v1-refresh:token:"));
    const res = await onRequestPost({ env, request: makeRequest({ refresh_token: "rt-secret" }) });
    expect(res.status).toBe(429);
    expect(refreshGrant).not.toHaveBeenCalled();
  });

  it("returns 429 and never calls GoTrue when the IP bucket is exhausted", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("v1-refresh:ip:"));
    const res = await onRequestPost({ env, request: makeRequest({ refresh_token: "rt-secret" }) });
    expect(res.status).toBe(429);
    expect(refreshGrant).not.toHaveBeenCalled();
  });
});
