import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { addApiOrigin, apiOriginFrom } from "../csp-api-origin.mjs";

describe("apiOriginFrom", () => {
  it("returns null when no API base is configured", () => {
    expect(apiOriginFrom(undefined)).toBeNull();
    expect(apiOriginFrom("")).toBeNull();
  });

  it("normalises an https origin", () => {
    expect(apiOriginFrom("https://api.example.com/")).toBe("https://api.example.com");
  });

  it("allows http only for localhost", () => {
    expect(apiOriginFrom("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => apiOriginFrom("http://api.example.com")).toThrow(/https/);
  });

  it("rejects paths, credentials and garbage", () => {
    expect(() => apiOriginFrom("https://api.example.com/v1")).toThrow(/origin only/);
    expect(() => apiOriginFrom("https://user:pw@api.example.com")).toThrow(/origin only/);
    expect(() => apiOriginFrom("not a url")).toThrow(/valid URL/);
  });
});

describe("addApiOrigin", () => {
  const headers = readFileSync(path.resolve(import.meta.dirname, "../../public/_headers"), "utf8");

  it("leaves the headers untouched without an API origin", () => {
    expect(addApiOrigin(headers, null)).toBe(headers);
  });

  it("adds the origin to every connect-src and nowhere else", () => {
    const before = headers.match(/connect-src 'self' https:\/\/\*\.supabase\.co/g).length;
    const updated = addApiOrigin(headers, "https://api.example.com");
    expect(updated.match(/connect-src 'self' https:\/\/\*\.supabase\.co https:\/\/api\.example\.com;/g)).toHaveLength(before);
    expect(updated.replaceAll(" https://api.example.com", "")).toBe(headers);
  });
});
