import { describe, it, expect, vi, beforeEach } from "vitest";

const signUp = vi.fn();
const ensureSessionDevice = vi.fn();
const checkRateLimit = vi.fn();
const adminClientMock = { marker: "admin-client" };

vi.mock("../../../lib/gotrue.js", () => ({
  AuthRejected: class AuthRejected extends Error {},
  signUp: (...args) => signUp(...args),
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

const { onRequestPost } = await import("../register.js");
const env = {};

function makeRequest(body) {
  return new Request("https://example.test/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  signUp.mockReset().mockResolvedValue({ access_token: "at", user: { id: "user-1" } });
  ensureSessionDevice.mockReset().mockResolvedValue({});
  checkRateLimit.mockReset().mockResolvedValue(true);
});

describe("POST /v1/auth/register rate limiting (F-13)", () => {
  it("checks both the email and IP buckets before calling GoTrue", async () => {
    await onRequestPost({ env, request: makeRequest({ email: "a@b.com", password: "12345678901234" }) });
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, "v1-register:email:a@b.com", expect.any(Object));
    expect(checkRateLimit).toHaveBeenCalledWith(adminClientMock, "v1-register:ip:1.2.3.4", expect.any(Object));
    expect(signUp).toHaveBeenCalled();
  });

  it("returns 429 and never calls GoTrue when the email bucket is exhausted", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("v1-register:email:"));
    const res = await onRequestPost({ env, request: makeRequest({ email: "a@b.com", password: "12345678901234" }) });
    expect(res.status).toBe(429);
    expect(signUp).not.toHaveBeenCalled();
  });
});
