// Run via docs/runbooks/LOCAL_E2E.md (needs the local stack described there). Requires ANON_KEY in the environment.
// Real end-to-end run of the customer portal: real GoTrue auth, real Postgres,
// real Pages Functions. Only Stripe is absent (a subscription row is seeded).
const { chromium } = require("@playwright/test");
const { execFileSync } = require("node:child_process");

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const API = process.env.E2E_API ?? "http://127.0.0.1:55321";
const ANON = process.env.ANON_KEY;
const EMAIL = `e2e+${Date.now()}@example.test`;
const PASSWORD = "CorrectHorse-Battery-12";

const visible = async (locator, ms = 12000) => {
  try { await locator.first().waitFor({ state: "visible", timeout: ms }); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    await sleep(250);
  }
  return false;
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const psql = (sql) =>
  execFileSync("docker", ["exec", process.env.E2E_DB_CONTAINER ?? "supabase_db_arcana-e2e", "psql", "-U", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();

async function fetchText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

async function signup(email) {
  const res = await fetch(`${API}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await res.json();
  return body.access_token;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  const urlOf = async () => (await page.locator(".linkfield--open code").first().textContent()).trim();

  // 1. Real signup (email confirmation off in the local stack) lands in the portal.
  await page.goto(`${BASE}/signup/`);
  await page.getByLabel("Email address").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account/ }).click();
  await page.waitForURL(/\/account\/?$/, { timeout: 15000 }).catch(() => {});
  check("signup creates a real account and lands in /account", /\/account\/?$/.test(page.url()), page.url());

  const acct = psql(`select m.account_id from public.account_members m join auth.users u on u.id=m.user_id where u.email='${EMAIL}'`);

  // 2. Without a subscription the portal says so and offers no Create link.
  await page.waitForSelector("#portal-main", { timeout: 10000 });
  check("no subscription: strip says Not subscribed", await visible(page.getByText("Not subscribed")));
  check("no subscription: Create link is not offered", (await page.getByRole("link", { name: "Create link" }).count()) === 0);

  // 3. Seed a subscription (Stripe would normally do this) and reload.
  psql(`insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
        select m.account_id,'sub_e2e_${Date.now()}','active','Arcana',0,now()+interval '30 days'
        from public.account_members m join auth.users u on u.id=m.user_id where u.email='${EMAIL}'`);
  await page.reload();
  await page.waitForSelector("#portal-main");
  check("subscribed: plan strip shows €6.99 Active", (await visible(page.getByText("€6.99/month"))) && (await visible(page.locator(".badge--ok", { hasText: "Active" }))));
  check("subscribed: empty state is shown", await visible(page.getByText("No VPN links yet")));

  // 4. Create a link (automatic location).
  await page.getByRole("link", { name: "Create link" }).first().click();
  await page.waitForURL(/links\/new/);
  await page.getByLabel("Link name").fill("Phone");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await page.waitForSelector(".created", { timeout: 15000 }).catch(() => {});
  const created = await page.locator(".created").count();
  check("create link: 'ready' panel with the access link", created === 1);
  const url1 = created ? await urlOf() : "";
  check("create link: URL has the expected shape", /^http:\/\/127\.0\.0\.1:8788\/sub\/[A-Za-z0-9_-]{43}\?format=links$/.test(url1), url1.slice(0, 60));

  // 5. The real VPN endpoint serves a configuration for that link.
  if (url1) {
    const sub = await fetchText(url1);
    check("VPN endpoint /sub/<token> returns 200", sub.status === 200, `status ${sub.status}`);
    check("VPN endpoint body is a vless/hysteria2 config", /vless:\/\/|hysteria2:\/\//.test(sub.text), sub.text.slice(0, 50).replace(/\n/g, " "));
    console.log("      (config host:", (sub.text.match(/@([a-z0-9.-]+):/) || [])[1], ")");
  }

  // 6. Stored sealed: nothing readable in the database.
  const stored = psql(`select count(*) from public.external_vpn_devices where subscription_token_ciphertext is not null and account_id='${acct}'`);
  check("access link is stored sealed (ciphertext present)", stored === "1");
  const token1 = decodeURIComponent((url1.split("/sub/")[1] || "").split("?")[0]);
  const leaks = psql(`select count(*) from public.external_vpn_devices where account_id='${acct}' and (subscription_token_ciphertext like '%${token1}%' or subscription_token_hash = '${token1}')`);
  check("the token never appears in the database in the clear", token1 && leaks === "0");

  // 7. List: masked; Reveal shows the same URL; Copy puts it on the clipboard.
  await page.getByRole("link", { name: "Done" }).click();
  await page.waitForURL(/\/account\/?$/);
  await page.waitForSelector(".link-row");
  const maskedText = (await page.locator(".link-row code").first().textContent()).trim();
  check("list: the link is masked by default", /•{8,}/.test(maskedText) && !maskedText.includes(token1), maskedText.slice(0, 40));
  await page.getByRole("button", { name: "Reveal" }).first().click();
  check("list: Reveal shows the same URL", !!(await until(async () => (await page.locator(".link-row .linkfield--open code").first().textContent()).trim() === url1)));
  await page.getByRole("button", { name: "Hide" }).first().click();
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.getByRole("button", { name: "Copy link" }).first().click();
  check("list: Copy puts the URL on the clipboard without showing it", !!(await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === url1)) && (await page.locator(".link-row .linkfield--open").count()) === 0);

  // 8. A brand-new browser session (fresh storage) can still copy it: it is the server that remembers.
  const ctx2 = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page2 = await ctx2.newPage();
  await page2.goto(`${BASE}/login/`);
  await page2.getByLabel("Email").fill(EMAIL);
  await page2.locator("#password").fill(PASSWORD);
  await page2.getByRole("button", { name: /Log in/ }).click();
  await page2.waitForURL(/\/account\/?$/, { timeout: 15000 }).catch(() => {});
  check("login: real sign-in works from a fresh browser", /\/account\/?$/.test(page2.url()));
  await page2.waitForSelector(".link-row");
  await page2.getByRole("button", { name: "Reveal" }).first().click();
  check("re-reveal works from a different session", !!(await until(async () => (await page2.locator(".link-row .linkfield--open code").first().textContent()).trim() === url1)));
  await page2.goto(`${BASE}/login/`);
  await page2.waitForURL(/\/account\/?$/, { timeout: 8000 }).catch(() => {});
  check("a signed-in user visiting /login is sent to /account", /\/account\/?$/.test(page2.url()));
  await ctx2.close();

  // 9. Replace: the old link dies, the new one works.
  await page.locator(".link-row a.link-row__title").first().click();
  await page.waitForSelector("#access-heading");
  await page.getByRole("button", { name: "Replace link", exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Replace link" }).click();
  const url2 = await until(async () => { const t = (await page.locator(".linkfield--open code").first().textContent()).trim(); return t && t !== url1 ? t : null; }, 15000);
  check("replace: a different link is issued", !!url2);
  const old = await fetchText(url1);
  const neu = url2 ? await fetchText(url2) : { status: 0 };
  check("replace: the old link stops working (404)", old.status === 404, `status ${old.status}`);
  check("replace: the new link works (200)", neu.status === 200, `status ${neu.status}`);

  // 10. Capacity: 3 devices per subscription.
  for (const name of ["Laptop", "Tablet"]) {
    await page.goto(`${BASE}/account/links/new/`);
    await page.getByLabel("Link name").fill(name);
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await page.waitForSelector(".created", { timeout: 15000 }).catch(() => {});
  }
  check("capacity: three links fit in one subscription", psql(`select count(*) from public.vpn_links where status='active' and account_id='${acct}'`) === "3");
  await page.goto(`${BASE}/account/links/new/`);
  await page.getByLabel("Link name").fill("Fourth");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await page.waitForTimeout(2500);
  check("capacity: the 4th link is refused with a clear message", (await page.getByText(/no free device place/i).count()) > 0);
  check("capacity: the refused attempt leaves no empty link behind", psql(`select count(*) from public.vpn_links where status='active' and account_id='${acct}'`) === "3");

  // 11. Revoke frees a place and kills the link.
  await page.goto(`${BASE}/account/`);
  await page.waitForSelector(".link-row");
  await page.locator(".link-row a.link-row__title", { hasText: "Tablet" }).click();
  await page.waitForSelector("#access-heading");
  await page.getByRole("button", { name: "Reveal" }).click();
  const tabletUrl = await until(async () => (await page.locator(".linkfield--open code").first().textContent()).trim(), 10000);
  await page.getByRole("button", { name: "Revoke link" }).first().click();
  await page.locator("dialog").getByRole("button", { name: "Revoke link" }).click();
  await page.waitForURL(/\/account\/?$/, { timeout: 10000 }).catch(() => {});
  check("revoke: the revoked link no longer works (404)", (await fetchText(tabletUrl)).status === 404);
  await page.goto(`${BASE}/account/links/new/`);
  await page.getByLabel("Link name").fill("Fourth again");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await page.waitForSelector(".created", { timeout: 15000 }).catch(() => {});
  check("revoke: a freed place can be used again", (await page.locator(".created").count()) === 1);

  // 12. Change location: a replacement link on another route; the old one is revoked.
  await page.goto(`${BASE}/account/`);
  await page.waitForSelector(".link-row");
  await page.locator(".link-row a.link-row__title", { hasText: "Fourth again" }).click();
  await page.waitForSelector("#access-heading");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Reveal" }).click();
  const beforeMove = await until(async () => (await page.locator(".linkfield--open code").first().textContent()).trim(), 10000);
  const currentRoute = psql(`select desired_route_id from public.vpn_links where name='Fourth again' and status='active' and account_id='${acct}' limit 1`);
  const targetLabel = currentRoute === "route_e2e_nl_fast" ? "Germany · Frankfurt" : "Netherlands · Amsterdam";
  const targetHost = currentRoute === "route_e2e_nl_fast" ? "de1.e2e.example.test" : "nl1.e2e.example.test";
  const detailUrl = page.url();
  const pickTarget = async () => {
    await page.getByText("Choose location").click();
    await page.locator("#link-route").selectOption({ label: targetLabel });
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "Create new link" }).click();
  };

  // 12a. At the device limit a replacement cannot be made, and the old link is kept.
  await pickTarget();
  check("move at the device limit: refused with a clear message", await visible(page.getByText(/no free device place/i), 15000));
  check("move at the device limit: the old link still works", (await fetchText(beforeMove)).status === 200);
  check("move at the device limit: nothing was left behind", psql(`select count(*) from public.vpn_links where status='active' and account_id='${acct}'`) === "3");

  // 12b. Free a place, then the same change succeeds: new link first, old one revoked.
  await page.goto(`${BASE}/account/`);
  await page.waitForSelector(".link-row");
  await page.locator(".link-row a.link-row__title", { hasText: "Laptop" }).click();
  await page.waitForSelector("#access-heading");
  await page.getByRole("button", { name: "Revoke link" }).first().click();
  await page.locator("dialog[open]").getByRole("button", { name: "Revoke link" }).click();
  await page.waitForURL(/\/account\/?$/, { timeout: 10000 }).catch(() => {});
  await page.goto(detailUrl);
  await page.waitForSelector("#access-heading");
  await page.waitForTimeout(1200);
  await pickTarget();
  check("move: shows the new link", await visible(page.getByText("Your new link is ready"), 15000));
  check("move: the old link was revoked", (await fetchText(beforeMove)).status === 404);
  const afterMove = await until(async () => (await page.locator(".linkfield--open code").first().textContent()).trim(), 10000);
  const movedBody = afterMove ? await fetchText(afterMove) : { status: 0, text: "" };
  check(`move: the new link serves the other node (${targetHost})`, movedBody.status === 200 && movedBody.text.includes(targetHost), `status ${movedBody.status}`);

  // 13. Isolation between customers (second real account).
  const tokenB = await signup(`e2e-b+${Date.now()}@example.test`);
  const listB = await (await fetch(`${BASE}/api/account/links`, { headers: { Authorization: `Bearer ${tokenB}` } })).json().catch(() => ({}));
  check("isolation: another customer sees none of these links", Array.isArray(listB.links) ? listB.links.length === 0 : false || listB.error === "Account not found");
  const aLink = psql(`select id||'|'||(select device_id from public.external_vpn_devices e where e.link_id=l.id and e.revoked_at is null limit 1) from public.vpn_links l where status='active' and account_id='${acct}' limit 1`).split("|");
  const crossReveal = await fetch(`${BASE}/api/account/links/${aLink[0]}/clients/${aLink[1]}/access-link`, { headers: { Authorization: `Bearer ${tokenB}` } });
  check("isolation: another customer cannot reveal a link (404)", crossReveal.status === 404, `status ${crossReveal.status}`);
  const noAuth = await fetch(`${BASE}/api/account/links/${aLink[0]}/clients/${aLink[1]}/access-link`);
  check("isolation: no session cannot reveal a link (401)", noAuth.status === 401, `status ${noAuth.status}`);

  // 14. Privacy: rate-limit keys are opaque hashes, never an email or an IP.
  const keys = psql(`select bucket_key from public.rate_limit_buckets`).split("\n").filter(Boolean);
  check("privacy: rate-limit buckets exist and are all opaque 64-hex hashes", keys.length > 0 && keys.every((k) => /^[0-9a-f]{64}$/.test(k)), `${keys.length} buckets`);

  // 15. Sign out.
  await page.goto(`${BASE}/account/`);
  await page.waitForSelector(".ps-user__button");
  await page.locator(".ps-user__button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 10000 }).catch(() => {});
  await page.goto(`${BASE}/account/`);
  await page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check("sign out: /account then requires login again", /\/login/.test(page.url()), page.url());

  check("no browser JS errors during the whole run", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
