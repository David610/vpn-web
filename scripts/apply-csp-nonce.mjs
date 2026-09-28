// Postbuild step (see package.json `postbuild`), runs automatically after
// `next build` via npm's lifecycle hooks.
//
// Why this exists: `next build` with `output: 'export'` pre-renders every
// route to static HTML at build time. Next's App Router always emits its RSC
// hydration payload as inline `<script>self.__next_f.push(...)</script>`
// tags directly in that HTML (see the real built output under out/*.html --
// every page has several of these). A `script-src 'self'` CSP with no
// 'unsafe-inline' blocks ALL of them, so the page loads but never hydrates:
// no event handlers attach, every form/button is dead. This is a real,
// browser-confirmed regression from the F-15 CSP hardening pass, not a
// theoretical one -- see docs/security's remediation notes for how it was
// found.
//
// Next.js's own CSP-nonce support (getScriptNonceFromHeader /
// x-nonce header convention, wired through middleware) requires a per-request
// server to read a header and thread a nonce into the render. `output:
// 'export'` has no such server -- middleware does not run for a static
// export, and there is no request at build time to read a nonce from. So the
// only static-export-compatible option that avoids a bare 'unsafe-inline' is
// a nonce fixed for the whole build: generate one random value per build,
// stamp it onto every one of Next's own inline hydration scripts in the
// already-built out/*.html files, and bake the same value into out/_headers'
// CSP script-src.
//
// Residual risk (call this what it is, not a full fix): a per-request nonce
// is supposed to be unguessable *and* unique per response. This one is fixed
// for the entire build and visible in the page's raw HTML source (anyone can
// `curl` a page and read the nonce value straight out of the markup).
// Browsers do hide the nonce *content attribute* from script introspection
// (`el.getAttribute('nonce')` / `el.nonce` reads back empty string once the
// node is attached), which blocks a naive DOM-based-XSS payload that reads
// the nonce via `document.querySelector('script').nonce` and reuses it. But
// an attacker who fetches the page's raw HTML text (e.g. `fetch(location.href)`)
// can still regex the nonce out of the source and forge a matching
// `<script nonce="...">`. This is a materially weaker guarantee than a true
// per-request nonce, but it still blocks the common case this CSP defends
// against: a generic/automated injected <script> or eval-based payload that
// does not specifically fetch-and-parse this build's HTML to steal the
// nonce first. Closing this gap for real requires either moving off static
// export (a Cloudflare Pages Function rendering per request, which could
// mint a true per-request nonce) or a per-page SHA-256 hash allowlist (we
// investigated this: the actual built output has 127 distinct inline-script
// hashes across 40 routes already, growing with every new page/component --
// impractical to keep a hand- or CI-verified header in sync with byte-exact
// content long term, so we did not take that path here).
//
// The placeholder token below (__CSP_NONCE__) is committed in public/_headers
// so that if this script is ever skipped, the shipped CSP contains a nonce
// value that matches nothing -- i.e. it fails closed (blocks all inline
// scripts, same as before this fix) rather than failing open.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("out");
const PLACEHOLDER = "__CSP_NONCE__";

function listHtmlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...listHtmlFiles(full));
    else if (entry.endsWith(".html")) results.push(full);
  }
  return results;
}

// One random nonce for this entire build. CSP nonces must be base64
// (RFC 4648 alphabet incl. '+/='); hex would also be accepted by browsers,
// but we use base64 to match what real CSP nonces conventionally look like.
const nonce = randomBytes(18).toString("base64");

// Insert nonce="..." on every inline <script> tag (i.e. one with no `src`
// attribute) that doesn't already have a nonce. External chunk scripts
// (`<script src="/_next/...">`) are left untouched -- they're already
// allowed via `script-src 'self'`, which is independent of the nonce match.
const SCRIPT_TAG_RE = /<script(\s[^>]*)?>/g;

function injectNonce(html) {
  return html.replace(SCRIPT_TAG_RE, (match, attrs) => {
    const attrString = attrs ?? "";
    if (/\bsrc\s*=/.test(attrString)) return match; // external script, untouched
    if (/\bnonce\s*=/.test(attrString)) return match; // already has one
    return `<script${attrString} nonce="${nonce}">`;
  });
}

const htmlFiles = listHtmlFiles(OUT_DIR);
if (htmlFiles.length === 0) {
  console.error(`apply-csp-nonce: no HTML files found under ${OUT_DIR} -- did next build/export run?`);
  process.exit(1);
}

let scriptsTagged = 0;
for (const file of htmlFiles) {
  const original = readFileSync(file, "utf8");
  const updated = injectNonce(original);
  if (updated !== original) {
    scriptsTagged += (updated.match(/nonce="/g) ?? []).length;
    writeFileSync(file, updated, "utf8");
  }
}

const headersPath = path.join(OUT_DIR, "_headers");
const headersOriginal = readFileSync(headersPath, "utf8");
if (!headersOriginal.includes(PLACEHOLDER)) {
  console.error(`apply-csp-nonce: ${PLACEHOLDER} not found in ${headersPath} -- CSP script-src was not wired up as expected.`);
  process.exit(1);
}
const headersUpdated = headersOriginal.split(PLACEHOLDER).join(nonce);
writeFileSync(headersPath, headersUpdated, "utf8");

console.log(
  `apply-csp-nonce: stamped nonce onto ${scriptsTagged} inline <script> tags across ${htmlFiles.length} pages, wrote nonce into out/_headers.`
);

// Sanity check: fail the build loudly if any inline (src-less) <script> in
// the output is missing a nonce -- that would mean a future Next.js version
// changed how it emits hydration scripts in a way this regex doesn't catch,
// and we'd rather fail the build than silently ship a page that CSP blocks
// from hydrating again.
let missing = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const matches = html.match(SCRIPT_TAG_RE) ?? [];
  for (const tag of matches) {
    if (!/\bsrc\s*=/.test(tag) && !/\bnonce\s*=/.test(tag)) {
      missing++;
      console.error(`apply-csp-nonce: inline script without nonce in ${file}: ${tag.slice(0, 120)}`);
    }
  }
}
if (missing > 0) {
  console.error(`apply-csp-nonce: ${missing} inline script(s) missing a nonce -- failing build.`);
  process.exit(1);
}
