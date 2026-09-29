import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isStaticRevisionConfig,
  validateStaticRevisionConfig,
  FORBIDDEN_TOP_LEVEL_FIELDS,
  MAX_STATIC_REVISION_BYTES,
} from "../static-revision.js";

// Identical copy of singbox-vpn's
// crates/compat-config/tests/fixtures/static_revision_v1_contract.json --
// the node-side Rust parser asserts the same valid/invalid split.
const contract = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "static-revision-v1-contract.json"), "utf8")
);

describe("static revision contract (revision_schema 1)", () => {
  it.each(contract.valid.map((doc) => [JSON.stringify(doc), doc]))("accepts %s", (_label, doc) => {
    expect(validateStaticRevisionConfig(doc)).toEqual({ ok: true });
  });

  it.each(contract.invalid.map((doc) => [JSON.stringify(doc), doc]))("rejects %s", (_label, doc) => {
    const verdict = validateStaticRevisionConfig(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/^static revision rejected: /);
  });

  it("covers every forbidden field in the shared fixture", () => {
    for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
      expect(contract.invalid.some((doc) => doc.static_config && Object.keys(doc.static_config).includes(field))).toBe(true);
    }
  });

  it("rejects a role change even when bundled with a valid field", () => {
    const verdict = validateStaticRevisionConfig({
      revision_schema: 1,
      static_config: { role: "relay", udp_probe: { retries: 3 } },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/security-sensitive/);
  });

  it("rejects oversized documents", () => {
    const verdict = validateStaticRevisionConfig({
      revision_schema: 1,
      static_config: { udp_probe: { retries: 3 } },
      padding: "x".repeat(MAX_STATIC_REVISION_BYTES),
    });
    expect(verdict.ok).toBe(false);
  });

  it("routes only documents carrying revision_schema/static_config as static", () => {
    expect(isStaticRevisionConfig({ schema_version: 1, users: [] })).toBe(false);
    expect(isStaticRevisionConfig([])).toBe(false);
    expect(isStaticRevisionConfig(null)).toBe(false);
    expect(isStaticRevisionConfig({ revision_schema: 1 })).toBe(true);
    expect(isStaticRevisionConfig({ static_config: {} })).toBe(true);
  });
});
