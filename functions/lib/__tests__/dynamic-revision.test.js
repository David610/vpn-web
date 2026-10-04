import { describe, it, expect } from "vitest";
import { isWellShapedDynamicRevisionConfig, validateDynamicRevisionConfig } from "../dynamic-revision.js";

describe("dynamic (users-store) revision shape", () => {
  it("accepts a versioned envelope with a well-shaped users array", () => {
    expect(isWellShapedDynamicRevisionConfig({ schema_version: 1, users: [] })).toBe(true);
    expect(isWellShapedDynamicRevisionConfig({ schema_version: 1, users: [{ id: "cred_a" }] })).toBe(true);
  });

  it("accepts a bare array of user objects (legacy shape)", () => {
    expect(isWellShapedDynamicRevisionConfig([])).toBe(true);
    expect(isWellShapedDynamicRevisionConfig([{ id: "cred_a" }, { id: "cred_b" }])).toBe(true);
  });

  it("accepts an envelope without schema_version", () => {
    expect(isWellShapedDynamicRevisionConfig({ users: [] })).toBe(true);
  });

  it("rejects an envelope missing users", () => {
    expect(isWellShapedDynamicRevisionConfig({ schema_version: 1 })).toBe(false);
    expect(isWellShapedDynamicRevisionConfig({})).toBe(false);
  });

  it("rejects users that is not an array", () => {
    expect(isWellShapedDynamicRevisionConfig({ users: "not-an-array" })).toBe(false);
    expect(isWellShapedDynamicRevisionConfig({ users: { id: "cred_a" } })).toBe(false);
  });

  it("rejects a users array containing a non-object entry", () => {
    expect(isWellShapedDynamicRevisionConfig({ users: ["cred_a"] })).toBe(false);
    expect(isWellShapedDynamicRevisionConfig([null])).toBe(false);
    expect(isWellShapedDynamicRevisionConfig([["nested-array"]])).toBe(false);
  });

  it("rejects a non-integer or negative schema_version", () => {
    expect(isWellShapedDynamicRevisionConfig({ schema_version: 1.5, users: [] })).toBe(false);
    expect(isWellShapedDynamicRevisionConfig({ schema_version: -1, users: [] })).toBe(false);
    expect(isWellShapedDynamicRevisionConfig({ schema_version: "1", users: [] })).toBe(false);
  });

  it("rejects null and non-object, non-array config", () => {
    expect(isWellShapedDynamicRevisionConfig(null)).toBe(false);
    expect(isWellShapedDynamicRevisionConfig("not-an-object")).toBe(false);
  });

  it("validateDynamicRevisionConfig mirrors the boolean check with an error message", () => {
    expect(validateDynamicRevisionConfig({ schema_version: 1, users: [] })).toEqual({ ok: true });
    const verdict = validateDynamicRevisionConfig({ role: "EXIT" });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/well-shaped users snapshot/);
  });
});
