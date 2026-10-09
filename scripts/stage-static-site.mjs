import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("out");
const STAGE_DIR = path.resolve("dist-static");
const SITE_DIR = path.join(STAGE_DIR, "site");

const FORBIDDEN_MARKERS = [/vless:\/\//i, /hysteria2:\/\//i, /"outbounds"\s*:/];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

if (!existsSync(path.join(OUT_DIR, "_headers"))) {
  console.error("stage-static-site: out/ is missing or incomplete; run `npm run build` first.");
  process.exit(1);
}

rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(SITE_DIR, { recursive: true });
cpSync(OUT_DIR, SITE_DIR, { recursive: true });

const files = walk(SITE_DIR);
const hits = [];
for (const file of files) {
  if (!/\.(html|js|css|json|txt|map)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const marker of FORBIDDEN_MARKERS) if (marker.test(text)) hits.push(`${path.relative(SITE_DIR, file)} matches ${marker}`);
}

const functionsAtStage = ["functions", "_worker.js", "_routes.json"].filter((name) => existsSync(path.join(STAGE_DIR, name)) || existsSync(path.join(SITE_DIR, name)));
if (functionsAtStage.length > 0) {
  console.error(`stage-static-site: unexpected server code in the artifact: ${functionsAtStage.join(", ")}`);
  process.exit(1);
}
if (hits.length > 0) {
  console.error("stage-static-site: VPN protocol strings found in the static artifact:\n" + hits.map((h) => `  - ${h}`).join("\n"));
  process.exit(1);
}

console.log(`stage-static-site: ${files.length} files in ${path.relative(process.cwd(), SITE_DIR)}, no functions bundle, no VPN protocol strings.`);
console.log("Deploy from the staging folder so wrangler cannot pick up ../functions:");
console.log("  cd dist-static && npx wrangler pages deploy site --project-name <project> --branch main");
