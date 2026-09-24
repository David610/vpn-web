import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { requireMiniAppUser } from "../telegram-mini-app-auth.js";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}
async function buildInitData(userId, botToken = BOT_TOKEN) {
  const fields = {
    user: JSON.stringify({ id: userId, username: "dm" }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const encoder = new TextEncoder();
  const secretKey = await hmac(encoder.encode("WebAppData"), encoder.encode(botToken));
  const hash = hex(await hmac(new Uint8Array(secretKey), encoder.encode(dataCheckString)));
  return new URLSearchParams({ ...fields, hash }).toString();
}

function req(initData) {
  const headers = {};
  if (initData !== null) headers["X-Telegram-Init-Data"] = initData;
  return new Request("https://example.test/api/telegram/me", { headers });
}

describe("requireMiniAppUser", () => {
  it("resolves the linked Arcana user for a valid, linked caller", async () => {
    const db = makeFakeSupabase({
      telegram_links: [{ user_id: "user-1", telegram_user_id: 42, telegram_username: "dm" }],
    });
    const initData = await buildInitData(42);
    const { user, response } = await requireMiniAppUser(req(initData), db, { TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(response).toBeNull();
    expect(user).toEqual({ id: "user-1", email: null, role: "authenticated" });
  });

  it("rejects a valid Telegram signature with no linked account", async () => {
    const db = makeFakeSupabase({ telegram_links: [] });
    const initData = await buildInitData(999);
    const { user, response } = await requireMiniAppUser(req(initData), db, { TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(user).toBeNull();
    expect(response.status).toBe(403);
  });

  it("rejects an invalid signature outright", async () => {
    const db = makeFakeSupabase({ telegram_links: [{ user_id: "user-1", telegram_user_id: 42 }] });
    const initData = await buildInitData(42, "wrong-token");
    const { user, response } = await requireMiniAppUser(req(initData), db, { TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(user).toBeNull();
    expect(response.status).toBe(401);
  });

  it("rejects a request with no initData header", async () => {
    const db = makeFakeSupabase({});
    const { user, response } = await requireMiniAppUser(req(null), db, { TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(user).toBeNull();
    expect(response.status).toBe(401);
  });
});
