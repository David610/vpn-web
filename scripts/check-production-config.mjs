#!/usr/bin/env node
// Refuses a production deploy while legal/support identity is still a
// placeholder. Runs as an npm "prebuild" step, so a plain local/CI build
// (no ARCANA_PRODUCTION_DEPLOY flag) is never blocked — only a deploy that
// explicitly declares itself production is.
//
// The deploy pipeline is responsible for setting ARCANA_PRODUCTION_DEPLOY=1
// alongside real NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_SUPPORT_EMAIL values,
// and for keeping docs/terms, docs/privacy and the impressum content real
// (this script cannot invent legal text, only refuse to ship placeholders).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const isProductionDeploy = process.env.ARCANA_PRODUCTION_DEPLOY === "1";

if (!isProductionDeploy) {
  console.log(
    "check-production-config: ARCANA_PRODUCTION_DEPLOY is not set — skipping placeholder gate (non-production build)."
  );
  process.exit(0);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const problems = [];

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "";
const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "";

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

const legalFiles = [
  "src/app/terms/page.tsx",
  "src/app/privacy/page.tsx",
  "src/app/impressum/page.tsx",
];
const placeholderMarkers = [
  "legal-todo",
  "TODO",
  "[Company or sole-proprietor legal name]",
  "[Postal code, city, country]",
  "[contact email]",
];

for (const file of legalFiles) {
  let content;
  try {
    content = readFileSync(path.join(root, file), "utf8");
  } catch {
    problems.push(`Could not read ${file} to check for placeholder legal content.`);
    continue;
  }
  const hit = placeholderMarkers.find((marker) => content.includes(marker));
  if (hit) {
    problems.push(`${file} still contains placeholder/draft legal content (found "${hit}").`);
  }
}

if (problems.length > 0) {
  console.error("check-production-config: refusing production build — placeholder values remain:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nSet real NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_SUPPORT_EMAIL and complete legal review of terms/privacy/impressum before deploying to production."
  );
  process.exit(1);
}

console.log("check-production-config: production placeholder gate passed.");
