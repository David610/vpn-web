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
});
