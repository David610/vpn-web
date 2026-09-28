// Regression check for the P0 fixed in this branch: a `script-src` CSP that
// is present and restrictive, but blocks Next.js App Router's inline RSC
// hydration <script> tags, so the page loads yet never becomes interactive.
//
// This must be run against the real static output with the real `_headers`
// file actually enforced -- that's the whole point (the a11y check in
// scripts/a11y-visual-check.mjs serves `out/` via `python3 -m http.server`,
// which does NOT apply Cloudflare Pages' `_headers` file at all, which is
// exactly how the CSP/hydration regression this script guards against
// shipped unnoticed in the first place).
//
// Usage: npm run build && node scripts/verify-csp-hydration.mjs
// Requires `wrangler` (devDependency) and a free port; starts and stops its
// own `wrangler pages dev out` instance.

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.CSP_VERIFY_PORT ?? "18899";
const BASE = `http://127.0.0.1:${PORT}`;

const PAGES = ["/", "/login/", "/account/", "/admin/", "/telegram/"];

function startWrangler() {
  const child = spawn(
    "npx",
    ["wrangler", "pages", "dev", "out", "--port", PORT, "--compatibility-date=2024-01-01"],
    // shell: true is needed on Windows to resolve `npx` (a .cmd shim);
    // args are fixed literals above, not user input, so this is safe here.
    { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }
  );
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = buf.toString();
      if (text.includes("Ready on") && !ready) {
        ready = true;
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!ready) reject(new Error(`wrangler exited before becoming ready (code ${code})`));
    });
  });
  return { child, readyPromise };
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`Server at ${BASE} did not become ready in time`);
}

const { child, readyPromise } = startWrangler();
const failures = [];

try {
  await Promise.race([readyPromise, sleep(20000).then(() => { throw new Error("wrangler dev startup timed out"); })]);
  await waitForServer(15000);

  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
  );

  for (const path of PAGES) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cspViolations = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && /content security policy/i.test(msg.text())) {
        cspViolations.push(msg.text());
      }
    });

    const response = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20000 });
    const cspHeader = response?.headers()["content-security-policy"];

    if (!cspHeader) {
      failures.push(`${path}: no Content-Security-Policy header present (test is meaningless without it)`);
      await context.close();
      continue;
    }
    if (/script-src[^;]*'unsafe-inline'/.test(cspHeader) && !/nonce-/.test(cspHeader)) {
      failures.push(`${path}: script-src allows bare 'unsafe-inline' with no nonce/hash guard -- CSP hardening defeated`);
    }

    // Real hydration signal: inject a marker via a React state update path.
    // The simplest reliable, page-agnostic signal is that React has attached
    // a fiber to the root -- exposed by checking that a DOM node under the
    // Next.js root has React's internal fiber/props key, which only exists
    // post-hydration, not from server-rendered markup alone.
    const hydrated = await page.evaluate(() => {
      const root = document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        const key = Object.keys(node).find(
          (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$")
        );
        if (key) return true;
        node = walker.nextNode();
      }
      return false;
    });

    if (!hydrated) {
      failures.push(`${path}: no React fiber found on any DOM node -- page did not hydrate (CSP likely blocking inline hydration scripts)`);
    }

    if (cspViolations.length > 0) {
      failures.push(`${path}: CSP violation(s) reported in console: ${cspViolations.slice(0, 3).join(" | ")}`);
    }

    await context.close();
  }

  await browser.close();
} finally {
  child.kill();
}

console.log(`\n=== CSP hydration check (${PAGES.length} pages) ===`);
if (failures.length === 0) {
  console.log("PASS: CSP header present and restrictive on every page, and every page hydrated.");
} else {
  console.error(`FAIL: ${failures.length} issue(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
