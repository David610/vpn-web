import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const headersPath = path.join(__dirname, "..", "..", "public", "_headers");
const raw = readFileSync(headersPath, "utf8").replace(/\r\n/g, "\n");

// Minimal `_headers` file parser: enough to pull out, for a given path block
// (e.g. "/*" or "/admin"), the value of a named header on that block. Good
// enough for these directive-content assertions without pulling in a real
// Cloudflare Pages headers parser dependency.
function cspFor(blockHeader) {
  const lines = raw.split("\n");
  const startIndex = lines.findIndex((l) => l.trim() === blockHeader);
  if (startIndex === -1) throw new Error(`block ${blockHeader} not found`);
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const isIndented = /^[ \t]/.test(line);
    if (line.trim() !== "" && !isIndented) break; // next unindented block header
    const m = line.match(/^\s*Content-Security-Policy:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error(`no Content-Security-Policy found in block ${blockHeader}`);
}

function directives(csp) {
  const map = {};
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    map[name] = rest;
  }
  return map;
}

// A source list is "at least as strict" if it allows no origin the
// reference list doesn't already allow.
function isAtLeastAsStrict(candidate, reference) {
  if (!candidate) return true; // directive absent entirely is maximally strict (falls to default-src)
  if (!reference) return false;
  return candidate.every((token) => reference.includes(token));
}

describe("public/_headers CSP (F-15)", () => {
  const siteWide = directives(cspFor("/*"));
  const admin = directives(cspFor("/admin"));
  const adminWildcard = directives(cspFor("/admin/*"));

  it("site-wide CSP enforces Trusted Types with no unsafe script-src", () => {
    expect(siteWide["require-trusted-types-for"]).toEqual(["'script'"]);
    expect(siteWide["trusted-types"]).toEqual(["default"]);
    expect(siteWide["script-src"]).not.toContain("'unsafe-inline'");
    expect(siteWide["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("admin CSP also enforces Trusted Types", () => {
    for (const block of [admin, adminWildcard]) {
      expect(block["require-trusted-types-for"]).toEqual(["'script'"]);
      expect(block["trusted-types"]).toEqual(["default"]);
    }
  });

  it("admin script-src/connect-src allow no more origins than the site-wide policy", () => {
    for (const block of [admin, adminWildcard]) {
      expect(isAtLeastAsStrict(block["script-src"], siteWide["script-src"])).toBe(true);
      expect(isAtLeastAsStrict(block["connect-src"], siteWide["connect-src"])).toBe(true);
    }
  });

  it("admin CSP carries no third-party script or connect origins", () => {
    for (const block of [admin, adminWildcard]) {
      const scriptSrc = block["script-src"] ?? [];
      const connectSrc = block["connect-src"] ?? [];
      for (const token of [...scriptSrc, ...connectSrc]) {
        expect(token === "'self'" || token.includes("supabase.co")).toBe(true);
      }
    }
  });

  it("admin CSP keeps frame-ancestors and object-src at least as strict as site-wide", () => {
    for (const block of [admin, adminWildcard]) {
      expect(isAtLeastAsStrict(block["frame-ancestors"], siteWide["frame-ancestors"])).toBe(true);
      expect(block["object-src"]).toEqual(["'none'"]);
    }
  });
});
