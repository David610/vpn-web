// Run via docs/runbooks/LOCAL_E2E.md (needs the local stack described there). Requires ANON_KEY in the environment.
// Real end-to-end run of the Telegram Mini App: real GoTrue users, real Postgres,
// real Pages Functions, initData signed exactly as Telegram signs it.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8788";
const API_ORIGIN = process.env.E2E_API_BASE ?? BASE;
const API = process.env.E2E_API ?? "http://127.0.0.1:55321";
const ANON = process.env.ANON_KEY;
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const PASSWORD = "CorrectHorse-Battery-12";
const TG_A = 700000 + Math.floor(Math.random() * 90000);
const TG_B = TG_A + 1;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const psql = (sql) => execFileSync("docker", ["exec", process.env.E2E_DB_CONTAINER ?? "supabase_db_arcana-e2e", "psql", "-U", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();

function initData(telegramId, ageSeconds = 0, token = BOT_TOKEN) {
  const fields = { user: JSON.stringify({ id: telegramId, username: `tg${telegramId}` }), auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds) };
  const dcs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
async function tg(path, telegramId, { method = "GET", body, age = 0 } = {}) {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: { "X-Telegram-Init-Data": initData(telegramId, age), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}
async function newUser(label) {
  const email = `tg-${label}+${Date.now()}@example.test`;
  const res = await fetch(`${API}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await res.json();
  psql(`insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end) select m.account_id,'sub_tg_${label}_${Date.now()}','active','Arcana',0,now()+interval '30 days' from public.account_members m join auth.users u on u.id=m.user_id where u.email='${email}'`);
  return { email, token: body.access_token, id: body.user.id };
}
const fetchText = async (url) => { const r = await fetch(url); return { status: r.status, text: await r.text() }; };

(async () => {
  const A = await newUser("a");
  const B = await newUser("b");

  // 1. Not linked yet.
  const unlinked = await tg("/api/telegram/links", TG_A);
  check("unlinked Telegram user gets 403 not_linked", unlinked.status === 403 && unlinked.json.code === "not_linked");

  // 2. Real linking: the website makes a code, the Mini App redeems it with signed initData.
  const codeRes = await fetch(`${API_ORIGIN}/api/account/telegram/link-code`, { method: "POST", headers: { Authorization: `Bearer ${A.token}` } });
  const code = (await codeRes.json()).code;
  check("website issues a Telegram linking code", codeRes.status === 200 && !!code, `status ${codeRes.status}`);
  const linked = await tg("/api/telegram/link", TG_A, { method: "POST", body: { code } });
  check("the Mini App links the account with that code", linked.status === 200, `status ${linked.status} ${JSON.stringify(linked.json).slice(0, 80)}`);
  const codeB = (await (await fetch(`${API_ORIGIN}/api/account/telegram/link-code`, { method: "POST", headers: { Authorization: `Bearer ${B.token}` } })).json()).code;
  await tg("/api/telegram/link", TG_B, { method: "POST", body: { code: codeB } });

  // 3. Authentication.
  const noHeader = await fetch(`${API_ORIGIN}/api/telegram/links`);
  check("no initData: 401", noHeader.status === 401);
  const wrongBot = await (await fetch(`${API_ORIGIN}/api/telegram/links`, { headers: { "X-Telegram-Init-Data": initData(TG_A, 0, "999:wrong-token") } })).status;
  check("initData signed with another bot token: 401", wrongBot === 401);
  const tampered = initData(TG_A).replace(`%22id%22%3A${TG_A}`, `%22id%22%3A${TG_B}`);
  const tamperedStatus = (await fetch(`${API_ORIGIN}/api/telegram/links`, { headers: { "X-Telegram-Init-Data": tampered } })).status;
  check("tampered initData (swapped user id): 401", tamperedStatus === 401);
  check("initData older than 24h is rejected for reads", (await tg("/api/telegram/links", TG_A, { age: 25 * 3600 })).status === 401);

  // 4. List and plan card on an empty account.
  const empty = await tg("/api/telegram/links", TG_A);
  check("list: empty account with a plan card (€6.99, 3 devices)", empty.status === 200 && empty.json.links.length === 0 && empty.json.plan?.priceCents === 699 && empty.json.plan?.capacity === 3, JSON.stringify(empty.json.plan));
  check("list: offers the seeded locations", empty.json.routes?.map((r) => r.id).sort().join() === "route_e2e_de_fast,route_e2e_nl_fast");

  // 5. Create, then fetch the real VPN configuration.
  const created = await tg("/api/telegram/links", TG_A, { method: "POST", body: { name: "Phone", locationMode: "auto" } });
  check("create: 201 with an access link", created.status === 201 && /\/sub\//.test(created.json.configurationUrl || ""), `status ${created.status}`);
  const url1 = created.json.configurationUrl;
  const cfg = await fetchText(url1);
  check("create: the link serves a real vless configuration", cfg.status === 200 && /vless:\/\//.test(cfg.text), `status ${cfg.status}`);

  // 6. Copy it again (reveal), with the security properties.
  const reveal = await tg(`/api/telegram/links/${created.json.id}/access-link`, TG_A);
  check("access-link: returns the same URL again", reveal.status === 200 && reveal.json.configurationUrl === url1);
  check("access-link: response is never cached", /no-store/.test(reveal.headers.get("cache-control") || ""));
  const staleReveal = await tg(`/api/telegram/links/${created.json.id}/access-link`, TG_A, { age: 2 * 3600 });
  check("access-link: initData older than 1h must be refreshed (reopen_required)", staleReveal.status === 401 && staleReveal.json.code === "reopen_required");
  const staleCreate = await tg("/api/telegram/links", TG_A, { method: "POST", body: { name: "Stale", locationMode: "auto" }, age: 2 * 3600 });
  check("create: initData older than 1h must be refreshed (reopen_required)", staleCreate.status === 401 && staleCreate.json.code === "reopen_required");
  const staleList = await tg("/api/telegram/links", TG_A, { age: 2 * 3600 });
  check("list: the same stale initData still reads (read window is 24h)", staleList.status === 200);

  // 7. Listing shows it with metadata only.
  const listed = await tg("/api/telegram/links", TG_A);
  const row = listed.json.links.find((l) => l.id === created.json.id);
  check("list: the new link appears with routing and location mode", !!row && row.locationMode === "auto" && row.privacyClass === "fast" && !!row.primaryClientId);
  check("list: response carries no token, ciphertext or URL", !/sub\/|token|cipher|nonce/i.test(JSON.stringify(listed.json)));

  // 8. Isolation between two linked customers.
  const crossReveal = await tg(`/api/telegram/links/${created.json.id}/access-link`, TG_B);
  check("isolation: another customer cannot reveal this link (404)", crossReveal.status === 404);
  check("isolation: another customer cannot revoke it (404)", (await tg(`/api/telegram/links/${created.json.id}`, TG_B, { method: "DELETE" })).status === 404);
  check("isolation: another customer cannot move it (404)", (await tg(`/api/telegram/links/${created.json.id}/move`, TG_B, { method: "POST", body: { locationMode: "auto" } })).status === 404);
  check("isolation: another customer's list is empty", (await tg("/api/telegram/links", TG_B)).json.links.length === 0);

  // 9. Replace: new link, old one dies.
  const replaced = await tg(`/api/telegram/links/${created.json.id}/replace`, TG_A, { method: "POST" });
  const url2 = replaced.json.configurationUrl;
  check("replace: a different access link is issued", replaced.status === 200 && url2 && url2 !== url1);
  check("replace: the old link stops working (404)", (await fetchText(url1)).status === 404);
  check("replace: the new link works (200)", (await fetchText(url2)).status === 200);
  check("replace: access-link now returns the new URL", (await tg(`/api/telegram/links/${created.json.id}/access-link`, TG_A)).json.configurationUrl === url2);

  // 10. Validation.
  for (const [label, body] of [["empty name", { name: "", locationMode: "auto" }], ["bad characters", { name: "a/b", locationMode: "auto" }], ["unknown mode", { name: "ok", locationMode: "fastest" }], ["manual without a route", { name: "ok", locationMode: "manual" }]]) {
    check(`create validation: ${label} is rejected (400)`, (await tg("/api/telegram/links", TG_A, { method: "POST", body })).status === 400);
  }

  // 11. Capacity: 3 devices per plan.
  await tg("/api/telegram/links", TG_A, { method: "POST", body: { name: "Laptop", locationMode: "manual", routeId: "route_e2e_nl_fast" } });
  await tg("/api/telegram/links", TG_A, { method: "POST", body: { name: "Tablet", locationMode: "auto" } });
  const fourth = await tg("/api/telegram/links", TG_A, { method: "POST", body: { name: "Fourth", locationMode: "auto" } });
  check("capacity: the 4th link is refused (409 capacity_exhausted)", fourth.status === 409 && fourth.json.code === "capacity_exhausted");
  const accountA = psql(`select m.account_id from public.account_members m join auth.users u on u.id=m.user_id where u.id='${A.id}'`);
  check("capacity: no empty link is left behind", psql(`select count(*) from public.vpn_links where status='active' and account_id='${accountA}'`) === "3");
  const movedAtLimit = await tg(`/api/telegram/links/${created.json.id}/move`, TG_A, { method: "POST", body: { locationMode: "manual", routeId: "route_e2e_nl_fast" } });
  check("move at the device limit: refused, and the old link keeps working", movedAtLimit.status === 409 && (await fetchText(url2)).status === 200);

  // The per-user write limiter allows 10 writes a minute; this run has used more. Wait out the window.
  console.log("      (waiting 62s for the per-user write limiter window to reset)");
  await new Promise((r) => setTimeout(r, 62000));

  // 12. Revoke, then move.
  const laptop = (await tg("/api/telegram/links", TG_A)).json.links.find((l) => l.name === "Laptop");
  const laptopUrl = (await tg(`/api/telegram/links/${laptop.id}/access-link`, TG_A)).json.configurationUrl;
  const revoked = await tg(`/api/telegram/links/${laptop.id}`, TG_A, { method: "DELETE" });
  check("revoke: 200 and the link is gone from the list", revoked.status === 200 && !(await tg("/api/telegram/links", TG_A)).json.links.some((l) => l.id === laptop.id));
  check("revoke: the revoked link no longer works (404)", (await fetchText(laptopUrl)).status === 404);
  const targetRoute = psql(`select desired_route_id from public.vpn_links where id='${created.json.id}'`) === "route_e2e_nl_fast" ? "route_e2e_de_fast" : "route_e2e_nl_fast";
  const targetHost = targetRoute === "route_e2e_nl_fast" ? "nl1.e2e.example.test" : "de1.e2e.example.test";
  const moved = await tg(`/api/telegram/links/${created.json.id}/move`, TG_A, { method: "POST", body: { locationMode: "manual", routeId: targetRoute } });
  console.log("      move response:", moved.status, JSON.stringify(moved.json).slice(0, 220));
  check("move: a replacement link on the other route, old link revoked", moved.status === 201 && moved.json.oldRevoked === true && (await fetchText(url2)).status === 404, `status ${moved.status}`);
  const movedCfg = moved.json.configurationUrl ? await fetchText(moved.json.configurationUrl) : { status: 0, text: "" };
  check(`move: the new link serves the ${targetHost} node`, movedCfg.status === 200 && movedCfg.text.includes(targetHost));

  // 13. Privacy: rate-limit keys stay opaque; no raw IP or Telegram id stored.
  const keys = psql(`select bucket_key from public.rate_limit_buckets`).split("\n").filter(Boolean);
  check("privacy: all rate-limit keys are opaque hashes", keys.length > 0 && keys.every((k) => /^[0-9a-f]{64}$/.test(k)), `${keys.length} buckets`);

  // 14. The Mini App UI against the real API (Telegram's WebApp object is the only thing faked).
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // Outside Telegram the real script would replace window.Telegram with an empty WebApp; keep our signed one.
  await page.route("https://telegram.org/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  const signed = initData(TG_A);
  await page.addInitScript((data) => {
    window.__calls = [];
    window.Telegram = { WebApp: { initData: data, initDataUnsafe: {}, colorScheme: "light", ready() {}, expand() {}, close() {}, onEvent() {}, setHeaderColor() {}, setBackgroundColor() {}, showConfirm(m, cb) { cb(true); }, openLink(u) { window.__calls.push(u); }, BackButton: { show() {}, hide() {}, onClick(cb) { window.__back = cb; }, offClick() {} } } };
  }, signed);
  await page.goto(`${BASE}/telegram/`);
  const appeared = await page.getByText("Your VPN links").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const cardCount = await page.locator(".tg-card").count();
  if (!appeared || cardCount < 2) console.log("      UI body:", (await page.locator("main").innerText()).split("\n").join(" | ").slice(0, 300));
  check("Mini App UI: loads and lists the real links", appeared && cardCount >= 2, `${cardCount} cards`);
  await page.getByRole("button", { name: "Copy" }).first().click();
  const copied = await page.waitForFunction(() => navigator.clipboard.readText().then((t) => /\/sub\//.test(t)), null, { timeout: 8000 }).then(() => true).catch(() => false);
  check("Mini App UI: Copy puts a real access link on the clipboard", copied);
  const before = await page.locator(".tg-card").count();
  await page.getByRole("button", { name: /Create link/ }).first().click();
  await page.getByLabel("Link name").fill("From the app");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const ready = await page.getByText("Your VPN link is ready").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("Mini App UI: creating a link shows the ready screen", ready);
  const shownUrl = ready ? (await page.locator(".tg-urlbox--open").first().textContent()).trim() : "";
  check("Mini App UI: the shown link works (200)", shownUrl && (await fetchText(shownUrl)).status === 200);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(1500);
  check("Mini App UI: the new link is in the list", (await page.locator(".tg-card").count()) === before + 1);
  check("no browser JS errors in the Mini App", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
