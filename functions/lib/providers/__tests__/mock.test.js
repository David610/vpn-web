import { describe, it, expect } from "vitest";
import { createMockProvider } from "../mock.js";

describe("mock provider adapter", () => {
  it("returns a distinct instance id and ip for each createInstance call", async () => {
    const provider = createMockProvider();
    const a = await provider.createInstance({ nodeId: "node-a", region: "test-1" });
    const b = await provider.createInstance({ nodeId: "node-b", region: "test-1" });
    expect(a.providerInstanceId).not.toBe(b.providerInstanceId);
    expect(a.ipAddress).not.toBe(b.ipAddress);
    expect(a.region).toBe("test-1");
  });

  it("defaults region when none is given", async () => {
    const provider = createMockProvider();
    const result = await provider.createInstance({ nodeId: "node-a" });
    expect(result.region).toBe("mock-region");
  });

  it("destroyInstance resolves without error", async () => {
    const provider = createMockProvider();
    await expect(provider.destroyInstance({ providerInstanceId: "mock-node-a-1" })).resolves.toBeUndefined();
  });
});
