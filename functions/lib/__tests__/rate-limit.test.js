import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, rateLimitedResponse, clientIpKey } from "../rate-limit.js";

const rpc = vi.fn();
const supabaseAdmin = { rpc };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  rpc.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("checkRateLimit", () => {
  it("calls check_rate_limit with the key/window/limit and returns true when allowed", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const allowed = await checkRateLimit(supabaseAdmin, "login:email:user@example.com", {
      windowSeconds: 60,
      limit: 5,
    });
    expect(allowed).toBe(true);
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_bucket_key: "login:email:user@example.com",
      p_window_seconds: 60,
      p_limit: 5,
    });
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
