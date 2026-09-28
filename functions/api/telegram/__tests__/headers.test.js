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
    // Round 2: script-src also carries a build-time nonce placeholder
    // (substituted by scripts/apply-csp-nonce.mjs postbuild) because Next's
    // App Router emits inline RSC hydration <script> tags on every page --
    // 'self' alone blocks them and the page never hydrates. See the
    // "ROUND 2 CORRECTION" comment in public/_headers for the full story.
    // The placeholder must never be a bare 'unsafe-inline' -- that would
    // defeat the point of this hardening.
    it("site-wide: locks script-src to 'self' plus the build-time nonce placeholder, no unsafe directives", () => {
      const csp = rules().get("/*").find((l) => l.startsWith("Content-Security-Policy:"));
      const directive = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith("script-src"));
      expect(directive).toBe("script-src 'self' 'nonce-__CSP_NONCE__'");
      expect(csp).not.toContain("unsafe-eval");
      expect(directive).not.toContain("unsafe-inline");
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
      it(`${path}: only widens script-src for Telegram's own bootstrap script (plus the same build-time nonce placeholder), not to 'unsafe-inline'`, () => {
        const csp = rules().get(path).find((l) => l.startsWith("Content-Security-Policy:"));
        const directive = csp.split(";").map((s) => s.trim()).find((d) => d.startsWith("script-src"));
        expect(directive).toBe("script-src 'self' 'nonce-__CSP_NONCE__' https://telegram.org");
        expect(directive).not.toContain("unsafe-inline");
      });
    }
  });
});
