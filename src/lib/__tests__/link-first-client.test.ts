import { describe, expect, it } from "vitest";
import { firstClientName, isValidLinkName, subscriptionForFirstClient } from "../link-first-client";

const sub = (id: string, status: string, used: number, capacity: number) => ({ id, status, used, capacity });

describe("subscriptionForFirstClient", () => {
  it("picks the first live subscription with a free device place", () => {
    expect(subscriptionForFirstClient([sub("a", "active", 3, 3), sub("b", "trialing", 1, 3)])?.id).toBe("b");
  });

  it("skips canceled subscriptions", () => {
    expect(subscriptionForFirstClient([sub("a", "canceled", 0, 3), sub("b", "active", 0, 3)])?.id).toBe("b");
  });

  it("returns null when nothing has room, so the page can say why", () => {
    expect(subscriptionForFirstClient([sub("a", "active", 3, 3)])).toBeNull();
    expect(subscriptionForFirstClient([])).toBeNull();
  });
});

describe("firstClientName", () => {
  it("uses the link name", () => {
    expect(firstClientName("Office router")).toBe("Office router");
  });

  it("stays within the 40-character client name limit", () => {
    expect(firstClientName("x".repeat(60))).toHaveLength(40);
  });
});

describe("isValidLinkName", () => {
  it("accepts ordinary names, including non-latin letters", () => {
    for (const name of ["My phone", "Büro (2)", "Laptop-2", "Дом", "  Travel  "]) expect(isValidLinkName(name)).toBe(true);
  });

  it("rejects empty, over-long and symbol-bearing names", () => {
    for (const name of ["", "   ", "x".repeat(41), "a/b", "<b>", "emoji 😀"]) expect(isValidLinkName(name)).toBe(false);
  });
});
