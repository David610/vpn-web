import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/rate-limit.js", () => ({
  checkRateLimit: vi.fn(),
  rateLimitedResponse: (message = "Too many attempts. Please try again later.") =>
    new Response(JSON.stringify({ error: message }), { status: 429, headers: { "Content-Type": "application/json" } }),
  clientIpKey: vi.fn(() => "1.2.3.4"),
}));

const resetPasswordForEmail = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { resetPasswordForEmail },
  })),
}));

const { checkRateLimit } = await import("../../../lib/rate-limit.js");
const { onRequestPost } = await import("../password-reset.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function postReq(body) {
  return new Request("https://example.test/api/account/password-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  checkRateLimit.mockReset().mockResolvedValue(true);
  resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("POST /api/account/password-reset", () => {
  it("calls resetPasswordForEmail server-side and returns the generic response for a real email", async () => {
    const res = await onRequestPost({ env, request: postReq({ email: "user@example.com" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      message: "If an account exists for this email, you will receive a reset link shortly.",
    });
    expect(resetPasswordForEmail).toHaveBeenCalledWith("user@example.com", { redirectTo: undefined });
  });

  it("rate-limits by email (F-13)", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("password-reset:email:"));
    const res = await onRequestPost({ env, request: postReq({ email: "user@example.com" }) });
    expect(res.status).toBe(429);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("rate-limits by IP as a backstop even across different emails (F-13)", async () => {
    checkRateLimit.mockImplementation(async (_db, key) => !key.startsWith("password-reset:ip:"));
    const res = await onRequestPost({ env, request: postReq({ email: "another@example.com" }) });
    expect(res.status).toBe(429);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("returns the same generic response for an unknown/nonexistent email, never leaking account existence", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const res = await onRequestPost({ env, request: postReq({ email: "nobody@example.com" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/if an account exists/i);
  });

  it("still returns the generic response (never an error) when GoTrue errors internally", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await onRequestPost({ env, request: postReq({ email: "user@example.com" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns the generic response for a malformed email without ever calling Supabase or the rate limiter", async () => {
    const res = await onRequestPost({ env, request: postReq({ email: "not-an-email" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON", async () => {
    const res = await onRequestPost({
      env,
      request: new Request("https://example.test/api/account/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    });
    expect(res.status).toBe(400);
  });
});
