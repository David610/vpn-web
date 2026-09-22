import { describe, it, expect } from "vitest";
import { resolveNodeForUser } from "../resolve-node.js";

describe("resolveNodeForUser", () => {
  it("returns node-1 (the only node today)", () => {
    expect(resolveNodeForUser()).toBe("node-1");
  });
});
