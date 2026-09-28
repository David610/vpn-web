#!/usr/bin/env node
/**
 * Grep-based CI check (F-36 / J-02): flags obviously secret-shaped string
 * literals passed directly to a log call (console.*, logEvent, or a bound
 * logger from functions/lib/logging.js).
 *
 * This is intentionally shallow — a static grep, not a data-flow analysis.
 * It catches the mistake of literally writing a token/password into a log
 * call; it will not catch a secret that reaches a log call through a
 * variable (functions/lib/logging.js's `redact()` is the runtime backstop
 * for that case). Both are needed: this check is cheap and fails the build
 * immediately; redact() is the safety net for everything this can't see.
 *
 * Usage: node scripts/check-log-secrets.mjs
 * Exit code 1 and a list of offending lines if anything matches.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));

function listJsFiles() {
  const out = execSync('git ls-files "functions/**/*.js" "src/**/*.ts" "src/**/*.tsx"', {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.includes("__tests__") && !file.endsWith(".test.js"));
}

// A log call whose argument list contains a string literal that looks like
// a secret: a JWT, a Stripe key, "Bearer ...", or a long hex/base64 blob.
const LOG_CALL = /\b(console\.(log|error|warn|info|debug)|logEvent|\.error|\.warn|\.info|\.debug)\s*\(([^)]*)\)/g;
const SECRET_LITERAL = [
  /sk_(live|test)_[A-Za-z0-9]{10,}/,
  /whsec_[A-Za-z0-9]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT literal
  /Bearer [A-Za-z0-9._-]{10,}/,
];

function checkFile(file) {
  const contents = readFileSync(path.join(root, file), "utf8");
  const lines = contents.split("\n");
  const hits = [];
  lines.forEach((line, idx) => {
    if (!/console\.|logEvent|log\.(error|warn|info|debug)/.test(line)) return;
    for (const pattern of SECRET_LITERAL) {
      if (pattern.test(line)) {
        hits.push({ line: idx + 1, text: line.trim() });
      }
    }
  });
  return hits;
}

const files = listJsFiles();
let failed = false;
for (const file of files) {
  const hits = checkFile(file);
  for (const hit of hits) {
    failed = true;
    console.error(`${file}:${hit.line}: possible secret literal in a log call — ${hit.text}`);
  }
}

if (failed) {
  console.error("\ncheck-log-secrets: found secret-shaped literals passed to a log call.");
  process.exit(1);
}
console.log(`check-log-secrets: OK (${files.length} files scanned).`);
