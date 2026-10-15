import { describe, expect, it } from "vitest";
import { subscriptionForClient, SUBSCRIPTION_CLIENTS, tryClientSubscription } from "../subscription-client-link";

const token = "a".repeat(43);
const generic = `https://account.example/sub/${token}?format=links`;

describe("client-aware subscription links", () => {
  it("changes only the representation, never the token, origin or path", () => {
    for (const { value } of SUBSCRIPTION_CLIENTS) {
      const original = new URL(generic);
      const output = new URL(subscriptionForClient(generic, value));
      expect(output.origin).toBe(original.origin);
      expect(output.pathname).toBe(original.pathname);
      expect(output.searchParams.get("format")).toBe(value);
      expect(output.searchParams.get("encoding")).toBe(value === "shadowrocket" ? "base64" : null);
    }
  });

  it("preserves backwards compatibility when a source URL is already client-specific", () => {
    const encoded = `https://account.example/sub/${token}?format=shadowrocket&encoding=base64`;
    expect(subscriptionForClient(encoded, "hiddify")).toBe(`https://account.example/sub/${token}?format=hiddify`);
    expect(subscriptionForClient(encoded, "shadowrocket")).toBe(encoded);
  });

  it("refuses to transform malformed, plaintext-remote or unrelated URLs", () => {
    for (const bad of [
      "http://account.example/sub/" + token + "?format=links",
      "https://account.example/account?format=links",
      "https://account.example/sub/invalid",
      "https://account.example/v1/provision/" + token,
    ]) {
      expect(() => subscriptionForClient(bad, "shadowrocket")).toThrow();
    }
  });

  it("works with local test URLs without weakening remote HTTPS", () => {
    const local = `http://localhost:8788/sub/${token}?format=links`;
    expect(subscriptionForClient(local, "incy")).toBe(`http://localhost:8788/sub/${token}?format=incy`);
  });

  it("never throws while rendering: an unrecognised URL yields null so the page can fall back", () => {
    expect(tryClientSubscription("not a url", "hiddify")).toBeNull();
    expect(tryClientSubscription("https://account.example/sub/short?format=links", "hiddify")).toBeNull();
    expect(tryClientSubscription(generic, "shadowrocket"))
      .toBe(`https://account.example/sub/${token}?format=shadowrocket&encoding=base64`);
  });
});
