import { describe, it, expect } from "vitest";
import {
  isProductionDeployEnv,
  checkProductionConfig,
  LEGAL_FILES,
} from "../check-production-config.mjs";

describe("isProductionDeployEnv", () => {
  it("is true when ARCANA_PRODUCTION_DEPLOY=1 is set explicitly", () => {
    expect(isProductionDeployEnv({ ARCANA_PRODUCTION_DEPLOY: "1" })).toBe(true);
  });

  it("is true on a Cloudflare Pages production-branch build with no opt-in flag", () => {
    // This is the accidental-omission case the gate exists to catch: nobody
    // set ARCANA_PRODUCTION_DEPLOY, but Cloudflare Pages says this build is
    // deploying the production branch.
    expect(isProductionDeployEnv({ CF_PAGES: "1", CF_PAGES_BRANCH: "main" })).toBe(true);
  });

  it("respects an ARCANA_PRODUCTION_BRANCH override", () => {
    expect(
      isProductionDeployEnv({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "production",
        ARCANA_PRODUCTION_BRANCH: "production",
      })
    ).toBe(true);
    expect(
      isProductionDeployEnv({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "main",
        ARCANA_PRODUCTION_BRANCH: "production",
      })
    ).toBe(false);
  });

  it("is false for a Cloudflare Pages preview deploy", () => {
    expect(isProductionDeployEnv({ CF_PAGES: "1", CF_PAGES_BRANCH: "some-feature-branch" })).toBe(
      false
    );
  });

  it("is false for a plain local/CI build with none of the env set", () => {
    expect(isProductionDeployEnv({})).toBe(false);
  });
});

describe("checkProductionConfig", () => {
  const goodEnv = {
    NEXT_PUBLIC_SITE_URL: "https://arcanavpn.io",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@arcanavpn.io",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    STRIPE_API_KEY: "sk_live_valid", STRIPE_SIGNING_SECRET: "whsec_valid",
    STRIPE_PRICE_ID: "price_base", STRIPE_SEAT_PRICE_ID: "price_pack",
    VPN_SECRETS_ENCRYPTION_KEY: "a".repeat(64), SUBSCRIPTION_TOKEN_HASH_KEY: "b".repeat(64),
    ADMIN_ORIGIN: "https://admin.arcanavpn.io", RESEND_API_KEY: "re_valid",
    ALERT_TO_EMAIL: "ops@arcanavpn.io", ALERT_FROM_EMAIL: "alerts@arcanavpn.io",
    ROUTE_SIGNING_PRIVATE_KEY: "c".repeat(64), ROUTE_SIGNING_KEY_ID: "production-2026",
    FLEET_TICK_SECRET: "d".repeat(64), REQUIRE_CLAIM_TOKEN: "false",
  };

  function fakeReadFile(cleanContent) {
    return () => cleanContent;
  }

  it("fails when a draft marker is present in a legal page and env indicates production", () => {
    const readFile = (filePath) => {
      if (filePath.replace(/\\/g, "/").endsWith("terms/page.tsx")) {
        return "TODO (legal review needed): this page is a structural draft";
      }
      return "final legal text, no placeholders here";
    };

    const problems = checkProductionConfig({ env: goodEnv, root: "/repo", readFile });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("src/app/terms/page.tsx"))).toBe(true);
  });

  it("fails when the impressum still has the placeholder legal name", () => {
    const readFile = (filePath) => {
      if (filePath.replace(/\\/g, "/").endsWith("impressum/page.tsx")) {
        return "Operator: [Company or sole-proprietor legal name]";
      }
      return "final legal text";
    };
    const problems = checkProductionConfig({ env: goodEnv, root: "/repo", readFile });
    expect(problems.some((p) => p.includes("impressum"))).toBe(true);
  });

  it("fails when SITE_URL or SUPPORT_EMAIL still fall back to arcana.example", () => {
    const readFile = fakeReadFile("final legal text");
    const problems = checkProductionConfig({
      env: { NEXT_PUBLIC_SITE_URL: "https://arcana.example", NEXT_PUBLIC_SUPPORT_EMAIL: "support@arcana.example" },
      root: "/repo",
      readFile,
    });
    expect(problems.some((p) => p.includes("NEXT_PUBLIC_SITE_URL"))).toBe(true);
    expect(problems.some((p) => p.includes("NEXT_PUBLIC_SUPPORT_EMAIL"))).toBe(true);
  });

  it("passes (no problems) when it is a preview/dev deploy with clean content and real env", () => {
    const readFile = fakeReadFile("final legal text, no placeholders here");
    const problems = checkProductionConfig({ env: goodEnv, root: "/repo", readFile });
    expect(problems).toEqual([]);
  });

  it("checks every legal file this gate is supposed to cover", () => {
    expect(LEGAL_FILES).toEqual(
      expect.arrayContaining([
        "src/app/terms/page.tsx",
        "src/app/privacy/policy/page.tsx",
        "src/app/impressum/page.tsx",
      ])
    );
  });

  it("never permits claim-token enforcement without explicit fleet verification", () => {
    const problems = checkProductionConfig({ env: { ...goodEnv, REQUIRE_CLAIM_TOKEN: "true" }, root: "/repo", readFile: fakeReadFile("final legal text") });
    expect(problems.some((p) => p.includes("CLAIM_TOKEN_FLEET_VERIFIED"))).toBe(true);
    expect(checkProductionConfig({ env: { ...goodEnv, REQUIRE_CLAIM_TOKEN: "true", CLAIM_TOKEN_FLEET_VERIFIED: "true" }, root: "/repo", readFile: fakeReadFile("final legal text") })).toEqual([]);
  });
});
