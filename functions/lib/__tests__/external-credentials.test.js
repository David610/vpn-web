import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../crypto.js";
import { newOpaqueId, newSubscriptionToken } from "../external-credentials.js";

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
});
