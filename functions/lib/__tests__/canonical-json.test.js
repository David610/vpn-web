import { describe, it, expect } from "vitest";
import { canonicalJsonString } from "../canonical-json.js";

describe("canonicalJsonString", () => {
  it("sorts object keys alphabetically", () => {
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys at every nesting depth, not just the top level", () => {
    expect(canonicalJsonString({ z: { d: 1, c: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"c":2,"d":1}}'
    );
  });

  it("preserves array element order (arrays are not sorted)", () => {
    expect(canonicalJsonString({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("emits no whitespace anywhere", () => {
    expect(canonicalJsonString({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  it("round-trips strings, numbers, booleans, and null exactly like JSON.stringify", () => {
    expect(canonicalJsonString({ s: "x\"y", n: 42, t: true, f: false, z: null })).toBe(
      '{"f":false,"n":42,"s":"x\\"y","t":true,"z":null}'
    );
  });

  it("matches tamara-next's documented fixed-vector output for a known payload", () => {
    // Cross-checked directly against tamara-next's _canonicalJson
    // (lib/infrastructure/control_plane/signed_route_directory.dart) for
    // this exact value -- this is the one test standing between "looks
    // right" and "the client can never verify a real response."
    const value = {
      schema_version: 1,
      directory_version: 42,
      issued_at: "2026-09-13T10:00:00Z",
      expires_at: "2026-09-13T11:00:00Z",
      key_id: "routes-2026-a",
      payload: { routes: [] },
    };
    expect(canonicalJsonString(value)).toBe(
      '{"directory_version":42,"expires_at":"2026-09-13T11:00:00Z","issued_at":"2026-09-13T10:00:00Z","key_id":"routes-2026-a","payload":{"routes":[]},"schema_version":1}'
    );
  });
});
