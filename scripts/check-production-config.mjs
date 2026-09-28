#!/usr/bin/env node
// Refuses a production deploy while legal/support identity is still a
// placeholder. Runs as an npm "prebuild" step.
//
// This gate decides "is this a production deployment" from the deployment
// environment itself, not from an opt-in flag that can be forgotten:
//
//   - Cloudflare Pages sets CF_PAGES=1 on every Pages build and
//     CF_PAGES_BRANCH to the branch being deployed (both are always present
//     in a Cloudflare Pages build — see
//     https://developers.cloudflare.com/pages/configuration/build-configuration/#environment-variables).
//     The branch Cloudflare Pages treats as "production" is configurable
//     per project but defaults to the repository's production branch
//     (here: "main"). ARCANA_PRODUCTION_BRANCH lets that default be
//     overridden if the Cloudflare Pages project's production branch is
//     ever set to something other than "main", without touching this file.
//   - ARCANA_PRODUCTION_DEPLOY=1 remains supported as an explicit override
//     for non-Cloudflare deploy paths (e.g. a manual `wrangler pages
//     deploy` from a workstation), but it is no longer required to arm the
//     gate — omitting it on an actual Cloudflare Pages production build no
//     longer skips the check. The gate fails closed: it only ever *skips*
//     when it can positively tell the build is not production.
//
// Any other build (a Cloudflare Pages preview deploy, `npm run build`
// locally, CI on a feature branch) is not production and is never blocked.
//
// The deploy pipeline is responsible for providing real
// NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_SUPPORT_EMAIL values on the production
// branch, and for keeping docs/terms, docs/privacy and the impressum
// content real (this script cannot invent legal text, only refuse to ship
// placeholders).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function isProductionDeployEnv(env = process.env) {
  if (env.ARCANA_PRODUCTION_DEPLOY === "1") return true;

  const productionBranch = env.ARCANA_PRODUCTION_BRANCH || "main";
  // CF_PAGES is set to "1" on every Cloudflare Pages build (production and
  // preview alike); CF_PAGES_BRANCH carries the branch actually being
  // deployed. A production Cloudflare Pages deploy is CF_PAGES=1 with
  // CF_PAGES_BRANCH equal to the configured production branch.
  if (env.CF_PAGES === "1" && env.CF_PAGES_BRANCH === productionBranch) return true;

  return false;
}

export const LEGAL_FILES = [
  "src/app/terms/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/impressum/page.tsx",
];

export const PLACEHOLDER_MARKERS = [
  "legal-todo",
  "TODO",
  "[Company or sole-proprietor legal name]",
  "[Postal code, city, country]",
  "[contact email]",
];

/**
 * Runs the placeholder gate against a given environment/root and returns
 * the list of problems found (empty when clean). Does not touch
 * process.exit/console so it can be exercised directly from tests.
 */
export function checkProductionConfig({ env = process.env, root, readFile = readFileSync } = {}) {
  const problems = [];

  const siteUrl = env.NEXT_PUBLIC_SITE_URL || "";
  const supportEmail = env.NEXT_PUBLIC_SUPPORT_EMAIL || "";

  if (!siteUrl || siteUrl.includes("arcana.example")) {
    problems.push(
      `NEXT_PUBLIC_SITE_URL is missing or still the placeholder domain (got: "${siteUrl || "(unset)"}").`
    );
  }
  if (!supportEmail || supportEmail.includes("arcana.example")) {
    problems.push(
      `NEXT_PUBLIC_SUPPORT_EMAIL is missing or still the placeholder address (got: "${supportEmail || "(unset)"}").`
    );
  }

  for (const file of LEGAL_FILES) {
    let content;
    try {
      content = readFile(path.join(root, file), "utf8");
    } catch {
      problems.push(`Could not read ${file} to check for placeholder legal content.`);
      continue;
    }
    const hit = PLACEHOLDER_MARKERS.find((marker) => content.includes(marker));
    if (hit) {
      problems.push(`${file} still contains placeholder/draft legal content (found "${hit}").`);
    }
  }

  return problems;
}

function main() {
  const isProductionDeploy = isProductionDeployEnv(process.env);

  if (!isProductionDeploy) {
    console.log(
      "check-production-config: not a production deployment (no ARCANA_PRODUCTION_DEPLOY=1, and CF_PAGES_BRANCH is not the production branch) — skipping placeholder gate."
    );
    process.exit(0);
  }

  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const problems = checkProductionConfig({ env: process.env, root });

  if (problems.length > 0) {
    console.error("check-production-config: refusing production build — placeholder values remain:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nSet real NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_SUPPORT_EMAIL and complete legal review of terms/privacy/impressum before deploying to production."
    );
    process.exit(1);
  }

  console.log("check-production-config: production placeholder gate passed.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
