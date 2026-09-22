import { describe, it, expect } from "vitest";
import { sanitizeJobResult } from "../admin-sanitize.js";

describe("sanitizeJobResult", () => {
  it("redacts subscription_url", () => {
    const clean = sanitizeJobResult({ vpn_user_id: "vpn-1", subscription_url: "https://secret" });
    expect(clean.vpn_user_id).toBe("vpn-1");
    expect(clean.subscription_url).toBe("[redacted]");
  });

  it("passes through null/undefined unchanged", () => {
    expect(sanitizeJobResult(null)).toBeNull();
    expect(sanitizeJobResult(undefined)).toBeUndefined();
  });

  it("passes through a result with no sensitive keys unchanged", () => {
    const result = { foo: "bar" };
    expect(sanitizeJobResult(result)).toEqual({ foo: "bar" });
  });
});
