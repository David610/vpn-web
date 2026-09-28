// F-15 (Trusted Types) verification: loads the actual built static export
// (`out/`) behind a real HTTP server that serves public/_headers exactly as
// Cloudflare Pages would (via `wrangler pages dev`, the same tool used to
// preview/deploy this app), then drives a real Chromium instance with
// Playwright and asserts no CSP or Trusted Types violation is reported in
// the console on each major page. This is the only way to know
// `require-trusted-types-for 'script'` + `trusted-types default` (see
// public/_headers, public/trusted-types-policy.js) do not break the real
// app -- reading the source is not evidence the policy works at runtime.
import { chromium } from "@playwright/test";

const BASE = process.env.TT_CHECK_BASE ?? "http://127.0.0.1:8788";

const FAKE_SESSION = {
  access_token: "fake.jwt.token",
  refresh_token: "fake-refresh-token",
  expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
  expires_in: 3600 * 24 * 365,
  token_type: "bearer",
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    email: "qa@arcana.example",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: new Date().toISOString(),
  },
};

const ADMIN_OVERVIEW_BODY = {
  customers: { total: 1, active: 1, trialing: 0, past_due: 0, canceled: 0 },
  vpn: { accounts: 1, enabled: 1, disabled: 0 },
  jobs: { pending: 0, claimed: 0, failed: 0 },
  nodes: { online: 1, offline: 0 },
  usage: { download_bps: 0, upload_bps: 0, month_download_bytes: 0, month_upload_bytes: 0, month_total_bytes: 0 },
  alerts: { open: 0 },
  abuse: { open: 0 },
};

const OVERVIEW_BODY = {
  email: "qa@arcana.example",
  role: "owner",
  trialAvailable: false,
  billingAccount: true,
  subscriptions: [],
  devices: [],
  capacity: { total: 0, used: 0 },
  plan: { includedDevices: 3, devicesPerPack: 3, basePriceCents: 699, packPriceCents: 699, maxExtraPacks: 10 },
};

const PAGES = [
  { path: "/", label: "home" },
  { path: "/login/", label: "login" },
  { path: "/account/", label: "account", session: true },
  { path: "/admin/", label: "admin", session: true, adminApi: true },
  { path: "/telegram/", label: "telegram" },
];

function jsonRoute(body) {
  return (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function checkPage(browser, pageDef) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cspViolations = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (/content security policy|trusted types|trustedtypepolicy|refused to/i.test(text)) {
      cspViolations.push(text);
    }
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  if (pageDef.session) {
    await page.addInitScript(
      ({ key, session }) => {
        window.localStorage.setItem(key, JSON.stringify(session));
      },
      { key: "arcana-auth-v1", session: FAKE_SESSION }
    );
  }

  await page.route("**/api/account/overview", jsonRoute(OVERVIEW_BODY));
  if (pageDef.adminApi) {
    await page.route("**/api/admin/overview", jsonRoute(ADMIN_OVERVIEW_BODY));
  }

  const response = await page.goto(`${BASE}${pageDef.path}`, { waitUntil: "networkidle", timeout: 20000 }).catch((e) => {
    pageErrors.push(`navigation failed: ${e.message}`);
    return null;
  });

  await page.waitForTimeout(500);

  // Confirm the header we're testing is actually being served, not just
  // present in source -- otherwise a passing check here would prove nothing.
  let cspHeader = null;
  if (response) {
    cspHeader = response.headers()["content-security-policy"];
  }

  await context.close();
  return { ...pageDef, cspViolations, pageErrors, cspHeader };
}

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
);

let hardFailure = false;
for (const pageDef of PAGES) {
  const result = await checkPage(browser, pageDef);
  const trustedTypesEnforced = result.cspHeader?.includes("require-trusted-types-for") ?? false;
  console.log(`\n[${result.label}] ${result.path}`);
  console.log(`  CSP header present: ${Boolean(result.cspHeader)}`);
  console.log(`  require-trusted-types-for present: ${trustedTypesEnforced}`);
  if (!result.cspHeader) {
    console.log(`  ::error::[${result.label}] no Content-Security-Policy header served`);
    hardFailure = true;
  }
  if (!trustedTypesEnforced) {
    console.log(`  ::error::[${result.label}] require-trusted-types-for missing from served CSP`);
    hardFailure = true;
  }
  if (result.cspViolations.length > 0) {
    console.log(`  ::error::[${result.label}] CSP/Trusted Types violation(s):`);
    for (const v of result.cspViolations) console.log(`    ${v}`);
    hardFailure = true;
  } else {
    console.log(`  no CSP/Trusted Types violations`);
  }
  if (result.pageErrors.length > 0) {
    console.log(`  ::error::[${result.label}] page error(s):`);
    for (const e of result.pageErrors) console.log(`    ${e}`);
    hardFailure = true;
  }
}

await browser.close();

if (hardFailure) {
  console.error("\nFAIL: Trusted Types / CSP check failed on at least one page.");
  process.exit(1);
} else {
  console.log("\nPASS: Trusted Types enforced with no violations on all checked pages.");
}
