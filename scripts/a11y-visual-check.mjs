// Stage C6 validation: real rendered /account/* and /admin/* pages across
// breakpoints, with a mocked Supabase session + mocked API responses
// (Playwright request interception) since no real Supabase/Stripe backend
// is reachable from this environment. Checks: horizontal overflow, missing
// accessible names on icon-only controls, and basic keyboard-focus
// reachability of the primary action. Screenshots saved for visual review.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:4173";
const OUT_DIR = "scratch/c6-screens";
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: "1440-desktop", width: 1440, height: 900 },
  { name: "1024-tablet", width: 1024, height: 768 },
  { name: "768-tablet", width: 768, height: 1024 },
  { name: "390-iphone", width: 390, height: 844 },
  { name: "360-android", width: 360, height: 800 },
];

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

const OVERVIEW_BODY = {
  email: "qa@arcana.example",
  role: "owner",
  trialAvailable: false,
  billingAccount: true,
  subscriptions: [
    {
      id: "sub-1",
      name: "Personal",
      status: "active",
      stripeStatus: "active",
      extraPacks: 1,
      capacity: 6,
      used: 4,
      currentPeriodEnd: new Date(Date.now() + 20 * 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    },
    {
      id: "sub-2",
      name: "Family laptop",
      status: "trialing",
      stripeStatus: "trialing",
      extraPacks: 0,
      capacity: 3,
      used: 1,
      currentPeriodEnd: new Date(Date.now() + 2 * 86400000).toISOString(),
      cancelAtPeriodEnd: false,
    },
  ],
  devices: [
    {
      id: "dev-1", name: "iPhone", platform: "ios", status: "ACTIVE",
      subscriptionId: "sub-1", createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(), current: true,
      placement: { status: "READY", error: null },
    },
    {
      id: "dev-2", name: "Work laptop", platform: "macos", status: "ACTIVE",
      subscriptionId: "sub-1", createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(), current: false,
      placement: { status: "READY", error: null },
    },
    {
      id: "dev-3", name: "Old Android", platform: "android", status: "REVOKED",
      subscriptionId: null, createdAt: new Date().toISOString(),
      lastSeenAt: null, current: false, placement: null,
    },
  ],
  capacity: { total: 9, used: 5 },
  plan: { includedDevices: 3, devicesPerPack: 3, basePriceCents: 699, packPriceCents: 699, maxExtraPacks: 10 },
};

const CONNECTION_PROFILES_BODY = {
  profiles: [
    { id: "p1", name: "Everyday", enabled: true, routingMode: "AUTO", preferredEntryLocationId: null, preferredExitLocationId: null, autoFailover: true },
    { id: "p2", name: "Germany", enabled: true, routingMode: "DIRECT", preferredEntryLocationId: null, preferredExitLocationId: "loc-de", autoFailover: false },
    { id: "p3", name: "Private route", enabled: true, routingMode: "DOUBLE_HOP", preferredEntryLocationId: "loc-se", preferredExitLocationId: "loc-de", autoFailover: false },
  ],
};

const LOCATIONS_BODY = {
  locations: [
    { id: "loc-de", countryCode: "DE", city: "Frankfurt", name: "Germany" },
    { id: "loc-se", countryCode: "SE", city: "Stockholm", name: "Sweden" },
  ],
};

const DEVICES_BODY = {
  devices: OVERVIEW_BODY.devices.map((d) => ({
    ...d,
    assignment: d.status === "ACTIVE" ? { profileId: "p1", assignedAt: new Date().toISOString(), profile: { id: "p1", name: "Everyday", enabled: true, routingMode: "AUTO" } } : null,
  })),
};

const ADMIN_OVERVIEW_BODY = {
  customers: { total: 128, active: 96, trialing: 14, past_due: 3, canceled: 15 },
  subscriptions: { live: 110, cancelling: 4, extra_packs: 22, accounts_with_several: 8 },
  devices: { active: 301, capacity: 420, over_capacity: 0, without_subscription: 0, unschedulable: 0 },
  members: { admin_grants: 2 },
  vpn: { accounts: 301, enabled: 298, disabled: 3 },
  jobs: { pending: 1, claimed: 0, failed: 0 },
  nodes: { online: 12, offline: 0 },
  usage: { download_bps: 0, upload_bps: 0, month_download_bytes: 0, month_upload_bytes: 0, month_total_bytes: 0 },
  alerts: { open: 0 },
  abuse: { open: 0 },
};

const ADMIN_SETTINGS_BODY = {
  plan: { includedDevices: 3, devicesPerPack: 3, basePriceCents: 699, packPriceCents: 699, currency: "EUR" },
  billing: { stripeApiKey: true, webhookSecret: true, basePrice: true, packPrice: true },
  fleet: { multiNodeScheduling: true, providerHetzner: true, dnsCloudflare: true, nodeDomain: "nodes.arcana.example", singboxVpnVersion: "v1.2.3", tickSecret: true },
  services: { credentialEncryption: true, email: true, telegram: false, siteUrl: "https://arcana.example" },
};

const ADMIN_SUBSCRIPTIONS_BODY = {
  subscriptions: [
    { id: "sub-1", accountId: "acc-1", ownerEmail: "qa@arcana.example", name: "Personal", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 20 * 86400000).toISOString(), extraPacks: 1, capacity: 6, activeDevices: 4, createdAt: new Date().toISOString() },
  ],
  page: 1, perPage: 50, total: 1, totalPages: 1,
};

const NOW = new Date().toISOString();
const ADMIN_NODES_BODY = {
  nodes: [
    { nodeId: "de-fra-1", status: "online", lastSeenAt: NOW, telemetryAt: NOW, agentVersion: "1.4.0", vpnVersion: "v1.2.3", singboxVersion: "1.11.0", uptimeSeconds: 864000, cpuPercent: 12.5, memoryPercent: 40.1, diskPercent: 22, networkRxBps: 1200000, networkTxBps: 900000, configuredUsers: 42, activeUsersRecent: 17, role: "EXIT", lifecycleState: "READY", location: { displayName: "Frankfurt", countryCode: "DE" }, desiredRevision: 3, observedRevision: 3, traffic: { sampledAt: NOW, connectionsOpen: 31, bpsUp: 800000, bpsDown: 2400000, todayBytesUp: 1e9, todayBytesDown: 5e9 } },
    { nodeId: "se-sto-1", status: "degraded", lastSeenAt: NOW, telemetryAt: NOW, agentVersion: "1.4.0", vpnVersion: "v1.2.3", singboxVersion: "1.11.0", uptimeSeconds: 3600, cpuPercent: 71, memoryPercent: 66, diskPercent: 30, networkRxBps: 300000, networkTxBps: 200000, configuredUsers: 9, activeUsersRecent: 2, role: "RELAY", lifecycleState: "DRAINING", location: { displayName: "Stockholm", countryCode: "SE" }, desiredRevision: 4, observedRevision: 3, traffic: { sampledAt: null, connectionsOpen: null, bpsUp: null, bpsDown: null, todayBytesUp: 0, todayBytesDown: 0 } },
  ],
};
const ADMIN_FLEET_TOPOLOGY_BODY = {
  locations: [
    { id: "loc-de", countryCode: "DE", city: "Frankfurt", displayName: "Frankfurt", enabled: true, nodes: 2, exitNodes: 2, relayNodes: 0, readyNodes: 2, states: { READY: 2 } },
    { id: "loc-se", countryCode: "SE", city: "Stockholm", displayName: "Stockholm", enabled: true, nodes: 1, exitNodes: 0, relayNodes: 1, readyNodes: 0, states: { DRAINING: 1 } },
  ],
  allowedPaths: [
    { id: "p1", kind: "DIRECT", entry: null, exit: "Frankfurt", enabled: true, requiredEntitlement: null },
    { id: "p2", kind: "DOUBLE_HOP", entry: "Stockholm", exit: "Frankfurt", enabled: false, requiredEntitlement: "double_hop" },
  ],
};
const ADMIN_FLEET_ASSIGNMENTS_BODY = {
  byNode: [{ nodeId: "de-fra-1", exit: 40, relay: 0, total: 40 }, { nodeId: "se-sto-1", exit: 0, relay: 6, total: 6 }],
  total: 46,
  assignments: [
    { deviceId: "3f2a9c1e-0000-0000-0000-000000000001", nodeId: "de-fra-1", hop: "EXIT", assignedAt: NOW, accountId: "a1b2c3d4-0000-0000-0000-000000000000", subscriptionId: "s1", platform: "ios", deviceStatus: "ACTIVE", placementStatus: "PLACED" },
  ],
  limit: 100,
};
const ADMIN_FLEET_OPERATIONS_BODY = {
  operations: [
    { id: "9d8c7b6a-0000-0000-0000-000000000000", type: "REPLACE_NODE", status: "RUNNING", nodeId: "de-fra-2", attempts: 1, lastError: null, nextAttemptAt: NOW, deadlineAt: NOW, createdAt: NOW, updatedAt: NOW, detail: {}, steps: [
      { index: 0, name: "CREATE_SERVER", status: "COMPLETED", nodeId: "de-fra-2", attempts: 1, error: null, startedAt: NOW, completedAt: NOW, detail: {} },
      { index: 1, name: "PUBLISH_DNS", status: "RUNNING", nodeId: "de-fra-2", attempts: 1, error: null, startedAt: NOW, completedAt: null, detail: {} },
    ] },
  ],
};
const ADMIN_FLEET_HEALTH_BODY = {
  nodes: [
    { nodeId: "de-fra-1", role: "EXIT", lifecycleState: "READY", lifecycleStateChangedAt: NOW, failedReason: null, location: "Frankfurt (DE)", probe: { lastAt: NOW, lastOk: true, consecutiveFailures: 0, consecutiveSuccesses: 12 }, capacity: { assignedDevices: 40, maxSessions: 200, utilization: 0.2, capacityMbps: 1000, cpuPercent: 12, memoryPercent: 40 }, revision: { desired: 3, observed: 3, inSync: true }, versions: { agent: "1.4.0", vpn: "v1.2.3", singbox: "1.11.0" }, bootstrap: { stage: "done", status: "OK" } },
    { nodeId: "se-sto-1", role: "RELAY", lifecycleState: "DRAINING", lifecycleStateChangedAt: NOW, failedReason: null, location: "Stockholm (SE)", probe: { lastAt: NOW, lastOk: false, consecutiveFailures: 2, consecutiveSuccesses: 0 }, capacity: { assignedDevices: 6, maxSessions: 100, utilization: 0.06, capacityMbps: 500, cpuPercent: 71, memoryPercent: 66 }, revision: { desired: 4, observed: 3, inSync: false }, versions: { agent: "1.4.0", vpn: "v1.2.3", singbox: "1.11.0" }, bootstrap: { stage: null, status: null } },
  ],
  revisions: [{ nodeId: "se-sto-1", revision: 4, reason: "rotate reality short id", createdAt: NOW }],
  events: [{ id: 1, action: "admin.node_lifecycle_transition", nodeId: "se-sto-1", createdAt: NOW }],
};
const ADMIN_FLEET_READINESS_BODY = {
  flags: [
    { name: "FEATURE_MULTI_NODE_SCHEDULING", enabled: true, purpose: "Scheduler places devices across nodes" },
    { name: "FEATURE_AUTO_NODE_HEALTH", enabled: false, purpose: "Probe/silence-driven lifecycle changes" },
  ],
  variables: [
    { name: "HETZNER_API_TOKEN", group: "Fleet provisioning", sensitive: true, required: true, purpose: "Create/delete node VMs", present: true },
    { name: "FLEET_REALITY_HANDSHAKE_SERVER", group: "Fleet provisioning", sensitive: false, required: true, purpose: "REALITY camouflage handshake target", present: false },
    { name: "ROUTE_SIGNING_PRIVATE_KEY", group: "Route signing", sensitive: true, required: true, purpose: "Signs /v1/routes directory", present: true },
  ],
  provisioningReady: false,
  missing: ["FLEET_REALITY_HANDSHAKE_SERVER"],
};
ADMIN_SETTINGS_BODY.readiness = [
  { name: "SUPABASE_URL", group: "Core", sensitive: false, required: true, purpose: "Supabase project URL", present: true },
  ...ADMIN_FLEET_READINESS_BODY.variables,
  { name: "FEATURE_AUTO_NODE_HEALTH", group: "Fleet automation flags", sensitive: false, required: false, purpose: "Probe/silence-driven lifecycle changes", present: false, enabled: false },
];

const PAGES = [
  { path: "/account/", label: "account-overview" },
  { path: "/account/subscriptions/", label: "account-subscriptions" },
  { path: "/account/devices/", label: "account-devices" },
  { path: "/account/connections/", label: "account-connections" },
  { path: "/account/billing/", label: "account-billing" },
  { path: "/account/security/", label: "account-security" },
  { path: "/account/help/", label: "account-help" },
  { path: "/admin/", label: "admin-overview", admin: true },
  { path: "/admin/subscriptions/", label: "admin-subscriptions", admin: true },
  { path: "/admin/settings/", label: "admin-settings", admin: true },
  { path: "/admin/nodes/", label: "admin-fleet-nodes", admin: true },
  { path: "/admin/fleet/locations/", label: "admin-fleet-locations", admin: true },
  { path: "/admin/fleet/assignments/", label: "admin-fleet-assignments", admin: true },
  { path: "/admin/fleet/operations/", label: "admin-fleet-operations", admin: true },
  { path: "/admin/fleet/health/", label: "admin-fleet-health", admin: true },
  { path: "/admin/fleet/readiness/", label: "admin-fleet-readiness", admin: true },
];

function jsonRoute(body) {
  return (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function setupMocks(page) {
  await page.route("**/api/account/overview", jsonRoute(OVERVIEW_BODY));
  await page.route("**/api/account/connection-profiles", jsonRoute(CONNECTION_PROFILES_BODY));
  await page.route("**/api/account/devices", jsonRoute(DEVICES_BODY));
  await page.route("**/api/locations", jsonRoute(LOCATIONS_BODY));
  await page.route("**/api/vpn/config**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferred_setup_url: "https://arcana.example/s/abc123", subscription_url: "https://arcana.example/s/abc123" }) })
  );
  await page.route("**/api/admin/overview", jsonRoute(ADMIN_OVERVIEW_BODY));
  await page.route("**/api/admin/settings", jsonRoute(ADMIN_SETTINGS_BODY));
  await page.route("**/api/admin/subscriptions**", jsonRoute(ADMIN_SUBSCRIPTIONS_BODY));
  await page.route("**/api/admin/nodes", jsonRoute(ADMIN_NODES_BODY));
  await page.route("**/api/admin/fleet/topology", jsonRoute(ADMIN_FLEET_TOPOLOGY_BODY));
  await page.route("**/api/admin/fleet/assignments**", jsonRoute(ADMIN_FLEET_ASSIGNMENTS_BODY));
  await page.route("**/api/admin/fleet/operations**", jsonRoute(ADMIN_FLEET_OPERATIONS_BODY));
  await page.route("**/api/admin/fleet/health", jsonRoute(ADMIN_FLEET_HEALTH_BODY));
  await page.route("**/api/admin/fleet/readiness", jsonRoute(ADMIN_FLEET_READINESS_BODY));
  await page.route("**/api/account/telegram", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ linked: false }) }));
}

async function injectSession(page, origin) {
  await page.addInitScript(
    ({ key, session }) => {
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    { key: "arcana-auth-v1", session: FAKE_SESSION }
  );
}

const findings = [];

async function checkPage(browser, viewport, pageDef) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await injectSession(page);
  await setupMocks(page);

  await page.goto(`${BASE}${pageDef.path}`, { waitUntil: "networkidle", timeout: 15000 }).catch((e) => {
    findings.push({ page: pageDef.label, viewport: viewport.name, issue: `navigation failed: ${e.message}` });
  });

  await page.waitForTimeout(300);

  // Horizontal overflow check
  const overflow = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const winWidth = document.documentElement.clientWidth;
    return { docWidth, winWidth, overflowing: docWidth > winWidth + 1 };
  });
  if (overflow.overflowing) {
    findings.push({
      page: pageDef.label, viewport: viewport.name,
      issue: `horizontal overflow: content ${overflow.docWidth}px > viewport ${overflow.winWidth}px`,
    });
  }

  // Icon-only buttons without accessible name
  const unlabeled = await page.evaluate(() => {
    const problems = [];
    document.querySelectorAll("button").forEach((btn) => {
      const text = btn.textContent?.trim();
      const ariaLabel = btn.getAttribute("aria-label");
      const title = btn.getAttribute("title");
      if (!text && !ariaLabel && !title) {
        problems.push(btn.outerHTML.slice(0, 120));
      }
    });
    return problems;
  });
  if (unlabeled.length > 0) {
    findings.push({ page: pageDef.label, viewport: viewport.name, issue: `${unlabeled.length} button(s) with no accessible name`, detail: unlabeled });
  }

  // Tap target size check (mobile viewports only) — WCAG 2.5.5 / 2.5.8 style, 24px min
  if (viewport.width <= 480) {
    const small = await page.evaluate(() => {
      const problems = [];
      document.querySelectorAll("button, a.btn, a.text-link").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.height < 24 || rect.width < 24)) {
          problems.push(`${el.tagName} "${el.textContent?.trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
      });
      return problems;
    });
    if (small.length > 0) {
      findings.push({ page: pageDef.label, viewport: viewport.name, issue: `${small.length} tap target(s) under 24px`, detail: small });
    }
  }

  if (consoleErrors.length > 0) {
    findings.push({ page: pageDef.label, viewport: viewport.name, issue: `console errors`, detail: consoleErrors.slice(0, 5) });
  }

  // Keyboard focus reachability: Tab a few times, confirm something gets focus
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const hasFocus = await page.evaluate(() => document.activeElement !== document.body);
  if (!hasFocus) {
    findings.push({ page: pageDef.label, viewport: viewport.name, issue: "no element receives keyboard focus after 2 Tab presses" });
  }

  const screenshotPath = path.join(OUT_DIR, `${pageDef.label}--${viewport.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  await context.close();
}

const browser = await chromium.launch();
for (const viewport of VIEWPORTS) {
  for (const pageDef of PAGES) {
    await checkPage(browser, viewport, pageDef);
  }
}
await browser.close();

console.log(`\n=== C6 findings (${findings.length}) ===`);
let hardFailure = false;
for (const f of findings) {
  const isNavigationFailure = f.issue.startsWith("navigation failed");
  if (isNavigationFailure) hardFailure = true;
  // GitHub Actions renders a "::warning::" line as an annotation on the
  // job summary and the diff, so a finding is visible on every PR without
  // needing to open the raw log -- the whole point of wiring this into CI
  // instead of leaving it a script nobody remembers to run by hand.
  console.log(`::${isNavigationFailure ? "error" : "warning"}::[${f.page} @ ${f.viewport}] ${f.issue}`);
  if (f.detail) console.log(`  ${JSON.stringify(f.detail).slice(0, 300)}`);
}
if (findings.length === 0) console.log("No issues found across all pages/viewports.");

// Only a page that failed to render at all fails the build -- every other
// finding here (missing aria-labels, small tap targets, horizontal
// overflow, stray console errors) is real accessibility/UX debt worth
// fixing, but none of it was previously gated by anything, and turning
// every one into a hard CI failure on day one would just make this step
// impossible to keep green and get disabled. A page that never rendered
// is unambiguously a regression, not existing debt.
if (hardFailure) {
  console.error("\nFAIL: at least one page failed to render entirely.");
  process.exit(1);
}
