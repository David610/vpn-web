import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../crypto.js";
import { legacySubscriptionTokenHash, mintCompatibilityCredentials, newOpaqueId, newSubscriptionToken, rateLimitIpHash, subscriptionTokenHash } from "../external-credentials.js";

const env = { VPN_SECRETS_ENCRYPTION_KEY: "22".repeat(32) };

describe("external credential identifiers", () => {
  it("uses independent high-entropy opaque identifiers", () => {
    const token = newSubscriptionToken();
    const principal = newOpaqueId("ext");
    const credential = newOpaqueId("cred");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(principal).toMatch(/^ext_[A-Za-z0-9_-]{43}$/);
    expect(credential).toMatch(/^cred_[A-Za-z0-9_-]{43}$/);
    expect(new Set([token, principal.slice(4), credential.slice(5)]).size).toBe(3);
  });

  it("stores a keyed one-way token lookup rather than the bearer token", async () => {
    const token = newSubscriptionToken();
    const digest = await hmacSha256Hex(token, "test-key-with-at-least-thirty-two-bytes-long");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(await hmacSha256Hex(token, "another-test-key-at-least-thirty-two-bytes")).not.toBe(digest);
  });

  it("domain-separates new token and IP hashes while retaining legacy lookup", async () => {
    const env = { SUBSCRIPTION_TOKEN_HASH_KEY: "test-key-with-at-least-thirty-two-bytes-long" };
    const value = "same-input";
    const legacy = await legacySubscriptionTokenHash(value, env);
    expect(legacy).toBe(await hmacSha256Hex(value, env.SUBSCRIPTION_TOKEN_HASH_KEY));
    expect(await subscriptionTokenHash(value, env)).not.toBe(legacy);
    expect(await rateLimitIpHash(value, env)).not.toBe(legacy);
    expect(await rateLimitIpHash(value, env)).not.toBe(await subscriptionTokenHash(value, env));
  });
});

// Entry and exit must use independently scoped credential material
// (ARCANA_PRODUCT_V1.md §4b) -- never the same credential shared across
// hops, which is exactly the bug this function exists to avoid repeating.
describe("mintCompatibilityCredentials", () => {
  it("mints exactly one hop-1 credential for a fast route", async () => {
    const credentials = await mintCompatibilityCredentials(env, "fast");
    expect(credentials).toHaveLength(1);
    expect(credentials[0].hop).toBe(1);
    expect(credentials[0].credential_id).toMatch(/^cred_[A-Za-z0-9_-]{43}$/);
  });

  it("mints two independently-scoped credentials, one per hop, for privacy_plus", async () => {
    const credentials = await mintCompatibilityCredentials(env, "privacy_plus");
    expect(credentials.map((c) => c.hop).sort()).toEqual([1, 2]);
    const [a, b] = credentials;
    expect(a.credential_id).not.toBe(b.credential_id);
    expect(a.credential_ciphertext).not.toBe(b.credential_ciphertext);
  });
});
