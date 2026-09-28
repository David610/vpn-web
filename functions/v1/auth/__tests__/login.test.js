import { describe, it, expect, vi, beforeEach } from "vitest";

const passwordGrant = vi.fn();
const ensureSessionDevice = vi.fn();
const checkRateLimit = vi.fn();
const adminClientMock = { marker: "admin-client" };

vi.mock("../../../lib/gotrue.js", () => ({
  AuthRejected: class AuthRejected extends Error {},
  passwordGrant: (...args) => passwordGrant(...args),
  sessionIdOf: () => "sess-1",
}));
vi.mock("../../../lib/account-http.js", () => ({
  adminClient: () => adminClientMock,
}));
vi.mock("../../../lib/account-service.js", () => ({
  ensureSessionDevice: (...args) => ensureSessionDevice(...args),
}));
vi.mock("../../../lib/rate-limit.js", () => ({
  checkRateLimit: (...args) => checkRateLimit(...args),
  rateLimitedResponse: (message) =>
    new Response(JSON.stringify({ error: message }), { status: 429, headers: { "Content-Type": "application/json" } }),
  clientIpKey: () => "1.2.3.4",
}));

const { onRequestPost } = await import("../login.js");
const env = {};

function makeRequest(body) {
  return new Request("https://example.test/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  passwordGrant.mockReset().mockResolvedValue({ access_token: "at", user: { id: "user-1" } });
  ensureSessionDevice.mockReset().mockResolvedValue({});
  checkRateLimit.mockReset().mockResolvedValue(true);
});

describe("POST /v1/auth/login rate limiting (F-13)", () => {
  it("checks both the email and IP buckets before calling GoTrue", async () => {
    await onRequestPost({ env, request: makeRequest({ email: "a@b.com", password: "pw" }) });
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, "v1-login:email:a@b.com", expect.any(Object));
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, "v1-login:ip:1.2.3.4", expect.any(Object));
    expect(passwordGrant).toHaveBeenCalled();
  });

  it("returns 429 and never calls GoTrue when the email bucket is exhausted", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("v1-login:email:"));
    const res = await onRequestPost({ env, request: makeRequest({ email: "a@b.com", password: "pw" }) });
    expect(res.status).toBe(429);
    expect(passwordGrant).not.toHaveBeenCalled();
  });

  it("returns 429 and never calls GoTrue when the IP bucket is exhausted", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("v1-login:ip:"));
    const res = await onRequestPost({ env, request: makeRequest({ email: "a@b.com", password: "pw" }) });
    expect(res.status).toBe(429);
    expect(passwordGrant).not.toHaveBeenCalled();
  });
});
