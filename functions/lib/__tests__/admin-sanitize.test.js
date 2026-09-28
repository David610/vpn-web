import { describe, it, expect } from "vitest";
import { sanitizeJobResult } from "../admin-sanitize.js";

describe("sanitizeJobResult", () => {
  it("redacts subscription_url", () => {
    const clean = sanitizeJobResult({ vpn_user_id: "vpn-1", subscription_url: "https://secret" });
    expect(clean.vpn_user_id).toBe("vpn-1");
    expect(clean.subscription_url).toBe("[redacted]");
  });

  it("redacts provisioning_url and other URL/credential-shaped fields (F-04)", () => {
    const clean = sanitizeJobResult({
      vpn_user_id: "vpn-1",
      provisioning_url: "https://node.example/provision/secret",
      setup_token: "abc123",
      config_secret: "xyz",
    });
    expect(clean.vpn_user_id).toBe("vpn-1");
    expect(clean.provisioning_url).toBe("[redacted]");
    expect(clean.setup_token).toBe("[redacted]");
    expect(clean.config_secret).toBe("[redacted]");
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
