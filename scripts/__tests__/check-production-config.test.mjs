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
    NEXT_PUBLIC_SITE_URL: "https://arcana.example.com",
    NEXT_PUBLIC_SUPPORT_EMAIL: "support@arcana.example.com",
  };

  function fakeReadFile(cleanContent) {
    return () => cleanContent;
  }

  it("fails when a draft marker is present in a legal page and env indicates production", () => {
    const readFile = (filePath) => {
      if (filePath.endsWith("terms/page.tsx")) {
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
      if (filePath.endsWith("impressum/page.tsx")) {
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
        "src/app/privacy/page.tsx",
        "src/app/impressum/page.tsx",
      ])
    );
  });
});
