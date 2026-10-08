import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet: listLinks, onRequestPost: createLink } = await import("../links/index.js");
const { onRequestGet: getLink, onRequestDelete: deleteLink } = await import("../links/[id]/index.js");
const { onRequestGet: revealLink } = await import("../links/[id]/access-link.js");
const { onRequestPost: replaceLink } = await import("../links/[id]/replace.js");
const { onRequestPost: moveLink } = await import("../links/[id]/move.js");

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  SUBSCRIPTION_TOKEN_HASH_KEY: "test-subscription-token-key-32-bytes",
  VPN_SECRETS_ENCRYPTION_KEY: "11".repeat(32),
};
const END = "2030-01-01T00:00:00.000Z";
const uuid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}
async function initData(telegramId, { ageSeconds = 0 } = {}) {
  const fields = {
    user: JSON.stringify({ id: telegramId, username: "tg" }),
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
  };
  const dcs = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(BOT_TOKEN));
  return new URLSearchParams({ ...fields, hash: hex(await hmac(new Uint8Array(secret), enc.encode(dcs))) }).toString();
}
function req(path, init, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (init) headers["X-Telegram-Init-Data"] = init;
  return new Request(`https://example.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ctx = (request, params = {}) => ({ env, request, params });
const fresh = () => initData(42);
const FRESH_BUT_NOT_WRITABLE = 2 * 3600; // inside the 24h read window, outside the 1h write window

let rateAllowed = true;

function seed({ usedDevices = 1 } = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }, { id: "acct-2" }],
      account_members: [
        { id: 1, account_id: "acct-1", user_id: "user-1", role: "owner" },
        { id: 2, account_id: "acct-2", user_id: "user-2", role: "owner" },
      ],
      subscriptions: [
        { id: 1, account_id: "acct-1", name: "Personal", stripe_subscription_id: "sub_secret1", status: "active", current_period_end: END, extra_seats: 0, created_at: "2026-01-01" },
        { id: 2, account_id: "acct-2", name: "Other", stripe_subscription_id: "sub_secret2", status: "active", current_period_end: END, extra_seats: 0, created_at: "2026-01-01" },
      ],
      devices: Array.from({ length: usedDevices }, (_, i) => ({
        id: uuid(i + 1), account_id: "acct-1", user_id: "user-1", name: `Device ${i + 1}`, status: "ACTIVE", subscription_id: 1, created_at: "2026-02-01",
      })),
      telegram_links: [
        { user_id: "user-1", telegram_user_id: 42, telegram_username: "tg" },
        { user_id: "user-2", telegram_user_id: 43, telegram_username: "other" },
      ],
      logical_routes: [
        { id: "route_de_fast", region: "de", privacy_class: "fast", display_name: "Germany", enabled: true },
        { id: "route_nl_fast", region: "nl", privacy_class: "fast", display_name: "Netherlands", enabled: true },
        { id: "route_private", region: "de", privacy_class: "privacy_plus", display_name: "Germany x2", enabled: true },
      ],
      vpn_links: [
        { id: "link-1", account_id: "acct-1", name: "Personal", configuration_family: "compatibility", desired_route_id: "route_de_fast", max_clients: 1, status: "active", location_mode: "auto", created_at: "2026-01-01", revoked_at: null },
        { id: "link-2", account_id: "acct-2", name: "Theirs", configuration_family: "compatibility", desired_route_id: "route_nl_fast", max_clients: 1, status: "active", location_mode: "manual", created_at: "2026-01-01", revoked_at: null },
      ],
      external_vpn_devices: [
        { device_id: "client-1", account_id: "acct-1", link_id: "link-1", client_type: "links", desired_route_id: "route_de_fast", created_at: "2026-01-01", revoked_at: null, subscription_token_hash: "not-public" },
        { device_id: "client-2", account_id: "acct-2", link_id: "link-2", client_type: "links", desired_route_id: "route_nl_fast", created_at: "2026-01-01", revoked_at: null },
      ],
    },
    {
      rpc: {
        check_rate_limit: () => ({ data: rateAllowed, error: null }),
        create_vpn_link(args, tables) {
          const id = `new-link-${tables.vpn_links.length + 1}`;
          tables.vpn_links.push({
            id, account_id: args.p_account_id, name: args.p_name, configuration_family: "compatibility", desired_route_id: args.p_route_id,
            max_clients: args.p_max_clients, status: "active", location_mode: "manual", created_at: new Date().toISOString(), revoked_at: null,
          });
          return { data: id, error: null };
        },
        create_vpn_link_client(args, tables) {
          if (args.p_subscription_id === 999) return { data: null, error: { message: "seats_full" } };
          const deviceId = `created-${tables.external_vpn_devices.length + 1}`;
          tables.external_vpn_devices.push({
            device_id: deviceId, account_id: args.p_account_id, link_id: args.p_link_id, idempotency_key: args.p_idempotency_key,
            client_type: args.p_client_type, subscription_token_hash: args.p_token_hash, desired_route_id: "route_de_fast",
            created_at: new Date().toISOString(), revoked_at: null,
          });
          return { data: deviceId, error: null };
        },
        revoke_vpn_link(args, tables) {
          const link = tables.vpn_links.find((l) => l.id === args.p_link_id && l.account_id === args.p_account_id && l.status === "active");
          if (!link) return { data: false, error: null };
          link.status = "revoked";
          link.revoked_at = new Date().toISOString();
          for (const c of tables.external_vpn_devices.filter((x) => x.link_id === link.id)) c.revoked_at = link.revoked_at;
          return { data: true, error: null };
        },
      },
    }
  );
}

beforeEach(() => {
  rateAllowed = true;
  db = seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const post = (path, body, init) => req(path, init, { method: "POST", body });

async function createdLink(name = "Phone") {
  const res = await createLink(ctx(post("/api/telegram/links", { name, locationMode: "auto" }, await fresh())));
  return { res, body: await res.clone().json() };
}

describe("Mini App links: authentication", () => {
  it.each([
    ["list", () => listLinks(ctx(req("/api/telegram/links", null)))],
    ["create", async () => createLink(ctx(post("/api/telegram/links", { name: "x", locationMode: "auto" }, null)))],
    ["reveal", () => revealLink(ctx(req("/api/telegram/links/link-1/access-link", null), { id: "link-1" }))],
  ])("%s rejects a request with no initData", async (_name, call) => {
    expect((await call()).status).toBe(401);
  });

  it("returns 403 not_linked for an unlinked Telegram user", async () => {
    const res = await listLinks(ctx(req("/api/telegram/links", await initData(777))));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_linked");
  });
});

describe("Mini App links: list", () => {
  it("shows every link on the caller's account with the plan, and nothing from other accounts", async () => {
    const res = await listLinks(ctx(req("/api/telegram/links", await fresh())));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links.map((l) => l.id)).toEqual(["link-1"]);
    expect(body.links[0]).toMatchObject({ name: "Personal", locationMode: "auto", routeLabel: "Germany", primaryClientId: "client-1" });
    expect(body.routes.map((r) => r.id)).toEqual(["route_de_fast", "route_nl_fast"]);
    expect(body.plan).toMatchObject({ status: "active", priceCents: 699 });
  });

  it("never exposes tokens or ciphertext", async () => {
    const text = await (await listLinks(ctx(req("/api/telegram/links", await fresh())))).text();
    expect(text).not.toMatch(/not-public|token|cipher|nonce|stripe|sub_secret/i);
  });
});

describe("Mini App links: create", () => {
  it("creates a link with its access link and returns the URL", async () => {
    const { res, body } = await createdLink();
    expect(res.status).toBe(201);
    expect(body.configurationUrl).toMatch(/^https:\/\/example\.test\/sub\//);
    const row = db._tables.vpn_links.find((l) => l.id === body.id);
    expect(row).toMatchObject({ account_id: "acct-1", name: "Phone", location_mode: "auto", max_clients: 1 });
  });

  it("can then copy the same link again", async () => {
    const { body } = await createdLink();
    const again = await revealLink(ctx(req(`/api/telegram/links/${body.id}/access-link`, await fresh()), { id: body.id }));
    expect(again.status).toBe(200);
    expect(again.headers.get("Cache-Control")).toBe("no-store");
    expect(await again.json()).toEqual({ configurationUrl: body.configurationUrl });
  });

  it("uses the chosen location when manual", async () => {
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Dutch", locationMode: "manual", routeId: "route_nl_fast" }, await fresh())));
    const { id } = await res.json();
    expect(db._tables.vpn_links.find((l) => l.id === id).desired_route_id).toBe("route_nl_fast");
  });

  it("refuses a two-server route the clients cannot use", async () => {
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Two", locationMode: "manual", routeId: "route_private" }, await fresh())));
    expect(res.status).toBe(422);
    expect(db._tables.vpn_links.filter((l) => l.account_id === "acct-1")).toHaveLength(1);
  });

  it.each([
    [{ name: "", locationMode: "auto" }],
    [{ name: "bad/name", locationMode: "auto" }],
    [{ name: "ok", locationMode: "fastest" }],
    [{ name: "ok", locationMode: "manual" }],
    [{ name: "ok", locationMode: "manual", routeId: "../etc" }],
  ])("rejects invalid input %j", async (input) => {
    const res = await createLink(ctx(post("/api/telegram/links", input, await fresh())));
    expect(res.status).toBe(400);
  });

  it("needs initData signed within the last hour", async () => {
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Phone", locationMode: "auto" }, await initData(42, { ageSeconds: FRESH_BUT_NOT_WRITABLE }))));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("reopen_required");
  });

  it("says so when there is no free device place, and creates nothing", async () => {
    db = seed({ usedDevices: 3 });
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Phone", locationMode: "auto" }, await fresh())));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("capacity_exhausted");
    expect(db._tables.vpn_links.filter((l) => l.account_id === "acct-1")).toHaveLength(1);
  });

  it("removes the empty link when its access link cannot be created", async () => {
    const original = db.rpc.getMockImplementation();
    db.rpc.mockImplementation(async (name, args) => (name === "create_vpn_link_client" ? { data: null, error: { message: "seats_full" } } : original(name, args)));
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Phone", locationMode: "auto" }, await fresh())));
    expect(res.status).toBe(409);
    const mine = db._tables.vpn_links.filter((l) => l.account_id === "acct-1");
    expect(mine.filter((l) => l.status === "active").map((l) => l.id)).toEqual(["link-1"]);
  });

  it("is rate limited per user", async () => {
    rateAllowed = false;
    const res = await createLink(ctx(post("/api/telegram/links", { name: "Phone", locationMode: "auto" }, await fresh())));
    expect(res.status).toBe(429);
    expect(db._tables.vpn_links.filter((l) => l.account_id === "acct-1")).toHaveLength(1);
  });
});

describe("Mini App links: access link", () => {
  it("does not reveal another account's link", async () => {
    const res = await revealLink(ctx(req("/api/telegram/links/link-2/access-link", await fresh()), { id: "link-2" }));
    expect(res.status).toBe(404);
  });

  it("asks to replace a link created before copying existed", async () => {
    const res = await revealLink(ctx(req("/api/telegram/links/link-1/access-link", await fresh()), { id: "link-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("access_link_unavailable");
  });

  it("needs initData signed within the last hour", async () => {
    const { body } = await createdLink();
    const res = await revealLink(ctx(req(`/api/telegram/links/${body.id}/access-link`, await initData(42, { ageSeconds: FRESH_BUT_NOT_WRITABLE })), { id: body.id }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("reopen_required");
  });

  it("is rate limited per user", async () => {
    const { body } = await createdLink();
    rateAllowed = false;
    const res = await revealLink(ctx(req(`/api/telegram/links/${body.id}/access-link`, await fresh()), { id: body.id }));
    expect(res.status).toBe(429);
    expect(await res.text()).not.toMatch(/sub\//);
  });

  it("replaces the link: the new one is returned and the old one is gone", async () => {
    const { body } = await createdLink();
    const replaced = await replaceLink(ctx(post(`/api/telegram/links/${body.id}/replace`, undefined, await fresh()), { id: body.id }));
    expect(replaced.status).toBe(200);
    const { configurationUrl } = await replaced.json();
    expect(configurationUrl).not.toBe(body.configurationUrl);
    const again = await revealLink(ctx(req(`/api/telegram/links/${body.id}/access-link`, await fresh()), { id: body.id }));
    expect(await again.json()).toEqual({ configurationUrl });
  });

  it("cannot replace another account's link", async () => {
    const res = await replaceLink(ctx(post("/api/telegram/links/link-2/replace", undefined, await fresh()), { id: "link-2" }));
    expect(res.status).toBe(404);
  });
});

describe("Mini App links: detail, edit and revoke", () => {
  it("reads one of the caller's links and refuses another account's", async () => {
    const own = await getLink(ctx(req("/api/telegram/links/link-1", await fresh()), { id: "link-1" }));
    expect(own.status).toBe(200);
    expect((await own.json()).link.id).toBe("link-1");
    const theirs = await getLink(ctx(req("/api/telegram/links/link-2", await fresh()), { id: "link-2" }));
    expect(theirs.status).toBe(404);
  });

  it("moves a link to another location: new link first, then the old one is revoked", async () => {
    const res = await moveLink(ctx(post("/api/telegram/links/link-1/move", { locationMode: "manual", routeId: "route_nl_fast" }, await fresh()), { id: "link-1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ oldRevoked: true });
    expect(body.configurationUrl).toMatch(/\/sub\//);
    const created = db._tables.vpn_links.find((l) => l.id === body.id);
    expect(created).toMatchObject({ name: "Personal", desired_route_id: "route_nl_fast" });
    expect(db._tables.vpn_links.find((l) => l.id === "link-1").status).toBe("revoked");
  });

  it("keeps the old link when the replacement cannot be made", async () => {
    db = seed({ usedDevices: 3 });
    const res = await moveLink(ctx(post("/api/telegram/links/link-1/move", { locationMode: "auto" }, await fresh()), { id: "link-1" }));
    expect(res.status).toBe(409);
    expect(db._tables.vpn_links.find((l) => l.id === "link-1").status).toBe("active");
  });

  it("cannot move another account's link", async () => {
    const res = await moveLink(ctx(post("/api/telegram/links/link-2/move", { locationMode: "auto" }, await fresh()), { id: "link-2" }));
    expect(res.status).toBe(404);
    expect(db._tables.vpn_links.find((l) => l.id === "link-2").status).toBe("active");
  });

  it("revokes a link and refuses another account's", async () => {
    const mine = await deleteLink(ctx(req("/api/telegram/links/link-1", await fresh(), { method: "DELETE" }), { id: "link-1" }));
    expect(mine.status).toBe(200);
    expect(db._tables.vpn_links.find((l) => l.id === "link-1").status).toBe("revoked");
    const theirs = await deleteLink(ctx(req("/api/telegram/links/link-2", await fresh(), { method: "DELETE" }), { id: "link-2" }));
    expect(theirs.status).toBe(404);
    expect(db._tables.vpn_links.find((l) => l.id === "link-2").status).toBe("active");
  });

  it("revoking needs initData signed within the last hour", async () => {
    const res = await deleteLink(ctx(req("/api/telegram/links/link-1", await initData(42, { ageSeconds: FRESH_BUT_NOT_WRITABLE }), { method: "DELETE" }), { id: "link-1" }));
    expect(res.status).toBe(401);
    expect(db._tables.vpn_links.find((l) => l.id === "link-1").status).toBe("active");
  });
});
