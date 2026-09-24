import { describe, it, expect } from "vitest";
import { getProviderAdapter, getMockProviderAdapter } from "../provider-adapter.js";

describe("getProviderAdapter", () => {
  it("returns a Hetzner adapter for 'hetzner'", () => {
    const adapter = getProviderAdapter("hetzner", { HETZNER_API_TOKEN: "t" });
    expect(adapter.name).toBe("hetzner");
  });

  it("rejects an unknown provider name", () => {
    expect(() => getProviderAdapter("aws", {})).toThrow(/Unknown or unsupported provider/);
  });

  it("never returns the mock adapter through the real registry, even if named explicitly", () => {
    // Guards against a request body's `provider: "mock"` ever reaching a
    // live environment and fabricating a fake, unreachable node.
    expect(() => getProviderAdapter("mock", {})).toThrow(/Unknown or unsupported provider/);
  });
});

describe("getMockProviderAdapter", () => {
  it("is a separate, explicit entry point for tests", () => {
    const adapter = getMockProviderAdapter();
    expect(adapter.name).toBe("mock");
  });
});
