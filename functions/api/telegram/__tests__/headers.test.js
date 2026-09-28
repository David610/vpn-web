import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const raw = readFileSync(fileURLToPath(new URL("../../../../public/_headers", import.meta.url)), "utf8");

function rules() {
  const out = new Map();
  let current = null;
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = [];
      out.set(line.trim(), current);
    } else current.push(line.trim());
  }
  return out;
}

describe("public/_headers", () => {
  it("keeps the site-wide clickjacking protection", () => {
    const all = rules().get("/*");
    expect(all).toContain("X-Frame-Options: DENY");
    expect(all.join("\n")).toContain("frame-ancestors 'none'");
  });

  for (const path of ["/telegram", "/telegram/*"]) {
    it(`lets Telegram Web frame the Mini App at ${path}`, () => {
      const r = rules().get(path);
      expect(r).toBeDefined();
      expect(r).toContain("! X-Frame-Options");
      expect(r).toContain("! Content-Security-Policy");
      const csp = r.find((l) => l.startsWith("Content-Security-Policy:"));
      expect(csp).toContain("https://web.telegram.org");
      expect(csp).not.toContain("frame-ancestors 'none'");
    });
  }

  // F-15: sessions live in localStorage, so a strict script-src is this
  // app's primary defense against token-stealing XSS. No route may relax
  // it to 'unsafe-inline'/'unsafe-eval', and connect-src must stay scoped
  // to Supabase + self rather than being left wide open.
  describe("F-15 CSP hardening", () => {
    it("site-wide: locks script-src to 'self' with no unsafe directives", () => {
      const csp = rules().get("/*").find((l) => l.startsWith("Content-Security-Policy:"));
      const directive = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith("script-src"));
      expect(directive).toBe("script-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
    });

    it("site-wide: scopes connect-src to self and Supabase only", () => {
      const csp = rules().get("/*").find((l) => l.startsWith("Content-Security-Policy:"));
      const directive = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith("connect-src"));
      expect(directive).toBe("connect-src 'self' https://*.supabase.co");
    });

    for (const path of ["/*", "/telegram", "/telegram/*"]) {
      it(`${path}: keeps frame-ancestors and object-src locked down`, () => {
        const csp = rules().get(path).find((l) => l.startsWith("Content-Security-Policy:"));
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'self'");
      });
    }

    for (const path of ["/telegram", "/telegram/*"]) {
      it(`${path}: only widens script-src for Telegram's own bootstrap script, not to 'unsafe-inline'`, () => {
        const csp = rules().get(path).find((l) => l.startsWith("Content-Security-Policy:"));
        const directive = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith("script-src"));
        expect(directive).toBe("script-src 'self' https://telegram.org");
      });
    }
  });
});
