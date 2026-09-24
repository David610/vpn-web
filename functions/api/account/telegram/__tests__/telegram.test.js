import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../../lib/__tests__/fake-supabase.js";
import { hashLinkCode } from "../../../../lib/telegram-link-code.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet: status } = await import("../index.js");
const { onRequestPost: issueLinkCode } = await import("../link-code.js");
const { onRequestPost: unlink } = await import("../unlink.js");
const { onRequestPost: consumeLink } = await import("../../../telegram/link.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}
async function buildInitData(userId, username = "dm") {
  const fields = {
    user: JSON.stringify({ id: userId, username }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const encoder = new TextEncoder();
  const secretKey = await hmac(encoder.encode("WebAppData"), encoder.encode(BOT_TOKEN));
  const hash = hex(await hmac(new Uint8Array(secretKey), encoder.encode(dataCheckString)));
  return new URLSearchParams({ ...fields, hash }).toString();
}

function authedReq(path) {
  return new Request(`https://example.test${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer good" },
  });
}
function authedPost(path, body) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function miniAppPost(path, body, initData) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "X-Telegram-Init-Data": initData, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seed(overrides = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ id: 1, account_id: "acct-1", user_id: "user-1", role: "owner" }],
      telegram_links: [],
      telegram_link_codes: [],
      ...overrides,
    },
    { user: { id: "user-1", email: "owner@example.com" } }
  );
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GET /api/account/telegram", () => {
  it("reports unlinked when no link exists", async () => {
    db = seed();
    const res = await status({ env, request: authedReq("/api/account/telegram") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, telegramUsername: null, linkedAt: null });
  });

  it("reports the linked Telegram username", async () => {
    db = seed({
      telegram_links: [
        { user_id: "user-1", telegram_user_id: 42, telegram_username: "dm", linked_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await status({ env, request: authedReq("/api/account/telegram") });
    const body = await res.json();
    expect(body).toEqual({ linked: true, telegramUsername: "dm", linkedAt: "2026-01-01T00:00:00Z" });
  });
});

describe("POST /api/account/telegram/link-code", () => {
  it("issues a code and stores only its hash", async () => {
    db = seed();
    const res = await issueLinkCode({ env, request: authedPost("/api/account/telegram/link-code") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(db._tables.telegram_link_codes).toHaveLength(1);
    expect(db._tables.telegram_link_codes[0].code_hash).not.toBe(body.code);
    expect(db._tables.telegram_link_codes[0].user_id).toBe("user-1");
  });

  it("refuses to issue a code when already linked", async () => {
    db = seed({ telegram_links: [{ user_id: "user-1", telegram_user_id: 1 }] });
    const res = await issueLinkCode({ env, request: authedPost("/api/account/telegram/link-code") });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/telegram/link (Mini App code consumption)", () => {
  it("links the Telegram account that supplies a valid code + valid initData", async () => {
    const codeHash = await hashLinkCode("ABCD1234");
    db = seed({
      telegram_link_codes: [
        { code_hash: codeHash, user_id: "user-1", expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null },
      ],
    });
    const initData = await buildInitData(42, "dm");
    const res = await consumeLink({
      env: { ...env, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      request: miniAppPost("/api/telegram/link", { code: "abcd1234" }, initData),
    });
    expect(res.status).toBe(200);
    expect(db._tables.telegram_links).toHaveLength(1);
    expect(db._tables.telegram_links[0]).toMatchObject({ user_id: "user-1", telegram_user_id: 42 });
    expect(db._tables.telegram_link_codes[0].consumed_at).not.toBeNull();
  });

  it("rejects an expired code", async () => {
    const codeHash = await hashLinkCode("EXPIRED1");
    db = seed({
      telegram_link_codes: [
        { code_hash: codeHash, user_id: "user-1", expires_at: new Date(Date.now() - 1000).toISOString(), consumed_at: null },
      ],
    });
    const initData = await buildInitData(42);
    const res = await consumeLink({
      env: { ...env, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      request: miniAppPost("/api/telegram/link", { code: "EXPIRED1" }, initData),
    });
    expect(res.status).toBe(400);
    expect(db._tables.telegram_links).toHaveLength(0);
  });

  it("rejects a tampered initData signature even with a valid code", async () => {
    const codeHash = await hashLinkCode("GOODCODE");
    db = seed({
      telegram_link_codes: [
        { code_hash: codeHash, user_id: "user-1", expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null },
      ],
    });
    const initData = (await buildInitData(42)).replace(/hash=[0-9a-f]+/, `hash=${"0".repeat(64)}`);
    const res = await consumeLink({
      env: { ...env, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      request: miniAppPost("/api/telegram/link", { code: "GOODCODE" }, initData),
    });
    expect(res.status).toBe(401);
    expect(db._tables.telegram_links).toHaveLength(0);
  });

  it("rejects reuse of an already-consumed code", async () => {
    const codeHash = await hashLinkCode("USEDCODE");
    db = seed({
      telegram_link_codes: [
        {
          code_hash: codeHash,
          user_id: "user-1",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: new Date().toISOString(),
        },
      ],
    });
    const initData = await buildInitData(42);
    const res = await consumeLink({
      env: { ...env, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      request: miniAppPost("/api/telegram/link", { code: "USEDCODE" }, initData),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/account/telegram/unlink", () => {
  it("removes an existing link", async () => {
    db = seed({ telegram_links: [{ user_id: "user-1", telegram_user_id: 42 }] });
    const res = await unlink({ env, request: authedPost("/api/account/telegram/unlink") });
    expect(res.status).toBe(200);
    expect(db._tables.telegram_links).toHaveLength(0);
  });

  it("404s when nothing is linked", async () => {
    db = seed();
    const res = await unlink({ env, request: authedPost("/api/account/telegram/unlink") });
    expect(res.status).toBe(404);
  });
});
