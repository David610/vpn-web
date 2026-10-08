import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_CATEGORIES, HELP_ITEMS } from "../help-content";

// Arcana is link-only: there is no Arcana app to download or promise.
const APP_LANGUAGE = /download (for|the)|install the app|apps page|windows (app|today)|power button|kill switch|\bin the app\b/i;

const PUBLIC_PAGES = [
  "src/app/page.tsx",
  "src/app/pricing/page.tsx",
  "src/app/privacy/page.tsx",
  "src/components/Nav.tsx",
  "src/components/Footer.tsx",
  "src/components/HeroActions.tsx",
];

describe("link-only copy", () => {
  it("help content never refers to an Arcana app", () => {
    const text = JSON.stringify({ HELP_CATEGORIES, HELP_ITEMS });
    expect(text).not.toMatch(APP_LANGUAGE);
  });

  it("every help item belongs to a declared category", () => {
    const ids = new Set(HELP_CATEGORIES.map((c) => c.id));
    for (const item of HELP_ITEMS) expect(ids.has(item.category)).toBe(true);
  });

  it.each(PUBLIC_PAGES)("%s does not promise an app or link to /apps", (file) => {
    const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
    expect(source).not.toMatch(APP_LANGUAGE);
    expect(source).not.toMatch(/href=["']\/apps/);
  });

  it("pricing and help only mention two servers when the flag allows it", async () => {
    const { TWO_SERVER_LINKS } = await import("../site-config");
    const help = JSON.stringify(HELP_ITEMS);
    if (!TWO_SERVER_LINKS) {
      expect(help).not.toMatch(/choose 2 servers/i);
      const pricing = readFileSync(path.resolve(process.cwd(), "src/app/pricing/page.tsx"), "utf8");
      expect(pricing).toMatch(/TWO_SERVER_LINKS \?/);
    }
  });
});
