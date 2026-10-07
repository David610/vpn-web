import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, rateLimitedResponse, clientIpKey } from "../rate-limit.js";

const PEPPER_ONE = "a".repeat(40);
const PEPPER_TWO = "b".repeat(40);
const rpc = vi.fn();
const supabaseAdmin = { rpc };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  rpc.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("checkRateLimit", () => {
  it("calls check_rate_limit with an opaque keyed hash of the key, never the raw key", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const env = { SUBSCRIPTION_TOKEN_HASH_KEY: PEPPER_ONE };
    const allowed = await checkRateLimit(supabaseAdmin, "v1-login:ip:203.0.113.7", {
      windowSeconds: 60,
      limit: 5,
      env,
    });
    expect(allowed).toBe(true);
    const args = rpc.mock.calls[0][1];
    expect(rpc.mock.calls[0][0]).toBe("check_rate_limit");
    expect(args.p_bucket_key).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_bucket_key).not.toContain("203.0.113.7");
    expect(args.p_window_seconds).toBe(60);
    expect(args.p_limit).toBe(5);
  });

  it("derives a stable bucket per key and a different bucket per key or secret", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const opts = (pepper) => ({ windowSeconds: 60, limit: 5, env: { SUBSCRIPTION_TOKEN_HASH_KEY: pepper } });
    await checkRateLimit(supabaseAdmin, "login:email:a@example.com", opts(PEPPER_ONE));
    await checkRateLimit(supabaseAdmin, "login:email:a@example.com", opts(PEPPER_ONE));
    await checkRateLimit(supabaseAdmin, "login:email:b@example.com", opts(PEPPER_ONE));
    await checkRateLimit(supabaseAdmin, "login:email:a@example.com", opts(PEPPER_TWO));
    const [a1, a2, b, a_other] = rpc.mock.calls.map((c) => c[1].p_bucket_key);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(a_other);
  });

  it("falls back to an unkeyed hash, and still enforces the limit, when the secret is too short", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const allowed = await checkRateLimit(supabaseAdmin, "login:email:user@example.com", {
      windowSeconds: 60,
      limit: 5,
      env: { SUBSCRIPTION_TOKEN_HASH_KEY: "short" },
    });
    expect(allowed).toBe(false);
    expect(rpc.mock.calls[0][1].p_bucket_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still never sends the raw key when no secret is configured", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await checkRateLimit(supabaseAdmin, "login:email:user@example.com", { windowSeconds: 60, limit: 5 });
    expect(rpc.mock.calls[0][1].p_bucket_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns false once the RPC reports the bucket is over its limit", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const allowed = await checkRateLimit(supabaseAdmin, "k", { windowSeconds: 60, limit: 5 });
    expect(allowed).toBe(false);
  });

  it("fails open (returns true) when the RPC errors, rather than blocking all auth", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const allowed = await checkRateLimit(supabaseAdmin, "k", { windowSeconds: 60, limit: 5 });
    expect(allowed).toBe(true);
  });

  it("fails open when the RPC call itself throws", async () => {
    rpc.mockRejectedValue(new Error("network error"));
    const allowed = await checkRateLimit(supabaseAdmin, "k", { windowSeconds: 60, limit: 5 });
    expect(allowed).toBe(true);
  });
});

describe("rateLimitedResponse", () => {
  it("returns a 429 with a Retry-After header", async () => {
    const res = rateLimitedResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "Too many attempts. Please try again later." });
  });
});

describe("clientIpKey", () => {
  it("prefers CF-Connecting-IP over X-Forwarded-For", () => {
    const req = new Request("https://example.test/", {
      headers: { "CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9, 8.8.8.8" },
    });
    expect(clientIpKey(req)).toBe("1.2.3.4");
  });

  it("falls back to the first X-Forwarded-For entry", () => {
    const req = new Request("https://example.test/", { headers: { "X-Forwarded-For": "9.9.9.9, 8.8.8.8" } });
    expect(clientIpKey(req)).toBe("9.9.9.9");
  });

  it("falls back to \"unknown\" with no IP headers", () => {
    const req = new Request("https://example.test/");
    expect(clientIpKey(req)).toBe("unknown");
  });
});
