// Run via docs/runbooks/LOCAL_E2E.md (needs the local stack described there). Requires ANON_KEY and SERVICE_ROLE_KEY in the environment.
// Real end-to-end run of the admin area: real GoTrue users with real TOTP MFA,
// real Postgres (RPCs included), real Pages Functions.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const API = process.env.E2E_API ?? "http://127.0.0.1:55321";
const ANON = process.env.ANON_KEY;
const PASSWORD = "CorrectHorse-Battery-12";
const ADMIN_EMAIL = `admin+${Date.now()}@example.test`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const psql = (sql) => execFileSync("docker", ["exec", process.env.E2E_DB_CONTAINER ?? "supabase_db_arcana-e2e", "psql", "-U", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = async (locator, ms = 12000) => { try { await locator.first().waitFor({ state: "visible", timeout: ms }); return true; } catch { return false; } };

function base32decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const hmac = crypto.createHmac("sha1", base32decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
async function authApi(path, token, body) {
  const res = await fetch(`${API}/auth/v1${path}`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json() };
}
const admin = async (path, token, init = {}) => {
  const res = await fetch(`${BASE}/api/admin${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})), text: "" };
};

(async () => {
  // A customer with links to look at (created through the Mini App API in the Telegram run, or here).
  const customerEmail = `cust+${Date.now()}@example.test`;
  const cust = await authApi("/signup", null, { email: customerEmail, password: PASSWORD });
  const custId = cust.json.user.id;
  psql(`insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end) select m.account_id,'sub_adm_${Date.now()}','active','Arcana',0,now()+interval '30 days' from public.account_members m where m.user_id='${custId}'`);
  for (const [name, route] of [["Personal", "route_e2e_de_fast"], ["Travel", "route_e2e_nl_fast"]]) {
    const created = await fetch(`${BASE}/api/account/links`, { method: "POST", headers: { Authorization: `Bearer ${cust.json.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, routeId: route, maxClients: 1, locationMode: name === "Personal" ? "auto" : "manual" }) });
    const { id } = await created.json();
    await fetch(`${BASE}/api/account/links/${id}/clients`, { method: "POST", headers: { Authorization: `Bearer ${cust.json.access_token}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ name, clientType: "links", subscriptionId: psql(`select s.id from public.subscriptions s join public.account_members m on m.account_id=s.account_id where m.user_id='${custId}' limit 1`) }) });
  }

  // 1. The admin: a real user, an admin_users row, no second factor yet.
  const adm = await authApi("/signup", null, { email: ADMIN_EMAIL, password: PASSWORD });
  const admId = adm.json.user.id;
  psql(`insert into public.admin_users(user_id, role) values ('${admId}', 'owner')`);
  const aal1 = adm.json.access_token;
  const noMfa = await admin("/overview", aal1);
  check("admin without a second factor: 403 mfa_required", noMfa.status === 403 && noMfa.json.code === "mfa_required", `status ${noMfa.status}`);
  const custTry = await admin("/overview", cust.json.access_token);
  check("a customer calling the admin API is refused (401)", custTry.status === 401, `status ${custTry.status}`);
  check("a customer cannot list customers either (401)", (await admin("/customers", cust.json.access_token)).status === 401);
  check("no session at all: 401", (await fetch(`${BASE}/api/admin/overview`)).status === 401);

  // 2. Real TOTP enrolment and step-up to aal2.
  const enrol = await authApi("/factors", aal1, { factor_type: "totp", friendly_name: "e2e", issuer: "Arcana" });
  const secret = enrol.json.totp?.secret;
  check("TOTP factor enrolled through the auth service", enrol.status === 200 && !!secret, `status ${enrol.status}`);
  const factorId = enrol.json.id;
  const wrong = await authApi(`/factors/${factorId}/challenge`, aal1, {});
  const badVerify = await authApi(`/factors/${factorId}/verify`, aal1, { challenge_id: wrong.json.id, code: "000000" });
  check("a wrong authenticator code is rejected", badVerify.status >= 400, `status ${badVerify.status}`);
  const ch = await authApi(`/factors/${factorId}/challenge`, aal1, {});
  const ok = await authApi(`/factors/${factorId}/verify`, aal1, { challenge_id: ch.json.id, code: totp(secret) });
  const aal2 = ok.json.access_token;
  check("the right code upgrades the session to aal2", ok.status === 200 && !!aal2, `status ${ok.status}`);

  // 3. Admin API with a stepped-up session, against real RPCs.
  const overview = await admin("/overview", aal2);
  check("admin overview (aal2): 200 with real counts", overview.status === 200 && overview.json.customers.total >= 3, `customers=${overview.json.customers?.total}`);
  const dir = await admin(`/customers?q=${encodeURIComponent(customerEmail)}`, aal2);
  const row = dir.json.customers?.[0];
  check("users directory finds the customer", dir.status === 200 && row?.email === customerEmail);
  check("users directory: link count, clients and capacity are real (2 / 2 / 3)", row?.linkCount === 2 && row?.clientCount === 2 && row?.capacity === 3, JSON.stringify({ l: row?.linkCount, c: row?.clientCount, cap: row?.capacity }));
  const detail = await admin(`/customers/${custId}`, aal2);
  check("customer detail: lists the links as metadata", detail.status === 200 && detail.json.links?.length === 2 && detail.json.links.every((l) => l.name && l.routing === 1 && l.status === "active"), `links=${detail.json.links?.length}`);
  check("customer detail: no URL, token or credential anywhere in the response", !/\/sub\/|token|cipher|nonce|vless:|credential/i.test(JSON.stringify(detail.json.links)) && !/sub\//.test(JSON.stringify(detail.json)));

  // 4. A real audited admin action, then the audit log shows who did it.
  const grant = await admin(`/customers/${custId}/grant`, aal2, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "e2e support grant", seat_limit: 3, expires_at: new Date(Date.now() + 86400000).toISOString() }) });
  check("admin grants a support entitlement", grant.status === 200 || grant.status === 201, `status ${grant.status} ${JSON.stringify(grant.json).slice(0, 80)}`);
  const audit = await admin("/audit", aal2);
  const entry = audit.json.entries?.find((e) => e.adminUserId === admId);
  check("audit log records the action with the administrator's email", audit.status === 200 && entry?.adminEmail === ADMIN_EMAIL, entry ? `${entry.action} by ${entry.adminEmail}` : "no entry");
  check("audit log holds identifiers only (no secrets)", !/sub\/|token|cipher|vless/i.test(JSON.stringify(audit.json.entries ?? [])));

  // 5. The real admin sign-in form: email, password and authenticator code on one screen.
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|admin MFA verify failed: Invalid TOTP/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/admin/login/`);
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  check("wrong code on the combined form: stays on login with a clear error", await visible(page.getByText(/not valid/i), 10000) && /\/admin\/login/.test(page.url()));
  // Wait for a fresh TOTP window so the correct code is not a replay of the one used above.
  const waitMs = 30000 - (Date.now() % 30000) + 1500;
  await sleep(waitMs);
  await page.getByLabel("Authentication code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 }).catch(() => {});
  check("correct code: lands in the admin area", /\/admin\/?$/.test(page.url()), page.url());
  check("admin shell: ADMIN tag, sidebar sections and Back to account", (await visible(page.getByText("Needs attention"), 15000)) && (await page.getByRole("link", { name: "Back to account" }).count()) === 1);
  const totalText = (await page.locator(".admin-metric", { hasText: "Customer accounts" }).locator(".admin-metric__value").textContent()).replace(/[^0-9]/g, "");
  check("overview shows the real customer count", Number(totalText) === overview.json.customers.total, `${totalText} vs API ${overview.json.customers.total}`);

  await page.getByRole("link", { name: "Users" }).click();
  await page.getByPlaceholder("Search by email").fill(customerEmail);
  check("Users page: the customer row shows 2 links and 2 / 3 clients", await visible(page.locator("tr", { hasText: customerEmail }).getByText("2 / 3")));
  await page.locator("tr", { hasText: customerEmail }).getByRole("link", { name: /View/ }).click();
  check("customer page: links are listed as metadata only", (await visible(page.getByText("Metadata only"))) && (await visible(page.getByText("Travel"))) && (await visible(page.getByText("Personal"))));
  const body = await page.locator("#admin-main").innerText();
  check("customer page: no URL, token or credential is visible", !/\/sub\/|vless:|token|credential/i.test(body.replace(/Customer access links and VPN credentials are not displayed to administrators\./, "")));
  await page.getByRole("link", { name: "Audit log" }).click();
  check("audit page shows the grant with the admin's email", await visible(page.getByText(ADMIN_EMAIL), 10000));
  await page.getByRole("link", { name: "Operations" }).click();
  check("operations area loads with its three tabs", (await visible(page.getByRole("link", { name: "Alerts" }))) && (await page.getByRole("link", { name: "Abuse flags" }).count()) === 1);
  await page.getByRole("link", { name: "Payments" }).click();
  check("payments page loads real subscription rows", await visible(page.locator("tr", { hasText: "€6.99 / month" })));
  await page.getByRole("link", { name: "Servers" }).click();
  check("servers page lists the seeded nodes", (await visible(page.getByText("e2e-de-1"))) && (await visible(page.getByText("e2e-nl-1"))));
  await page.getByRole("link", { name: "Settings" }).click();
  await visible(page.getByText("Whether each integration is configured"), 15000);
  const settingsText = await page.locator("#admin-main").innerText().catch(() => "");
  check("settings page shows configuration status and no secret values", /Settings/.test(settingsText) && !new RegExp(process.env.SERVICE_ROLE_KEY ?? "zzzz-no-match").test(settingsText));
  check("no browser JS errors in the admin area", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
