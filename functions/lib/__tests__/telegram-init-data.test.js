import { describe, it, expect } from "vitest";
import { verifyTelegramInitData } from "../telegram-init-data.js";

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";

function hex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}

/** Builds a validly-signed initData string, independent of the module under test. */
async function buildInitData({
  userId = 42,
  username = "dm",
  authDate = Math.floor(Date.now() / 1000),
  botToken = BOT_TOKEN,
  extraFields = {},
} = {}) {
  const fields = {
    user: JSON.stringify({ id: userId, username, first_name: "David" }),
    auth_date: String(authDate),
    query_id: "AAH123",
    ...extraFields,
  };

  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await hmac(encoder.encode("WebAppData"), encoder.encode(botToken));
  const hashBytes = await hmac(new Uint8Array(secretKey), encoder.encode(dataCheckString));
  const hash = hex(hashBytes);

  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

describe("verifyTelegramInitData", () => {
  it("accepts a validly-signed, fresh payload", async () => {
    const initData = await buildInitData();
    const result = await verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.user).toEqual({ id: 42, username: "dm", firstName: "David", lastName: null });
  });

  it("rejects a payload signed with the wrong bot token", async () => {
    const initData = await buildInitData();
    const result = await verifyTelegramInitData(initData, "999999:wrong-token-entirely");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid signature");
  });

  it("rejects a tampered field (user id changed after signing)", async () => {
    const initData = await buildInitData({ userId: 42 });
    const tampered = initData.replace('%22id%22%3A42', '%22id%22%3A99');
    const result = await verifyTelegramInitData(tampered, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid signature");
  });

  it("rejects a tampered hash", async () => {
    const initData = await buildInitData();
    const params = new URLSearchParams(initData);
    params.set("hash", "0".repeat(64));
    const result = await verifyTelegramInitData(params.toString(), BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid signature");
  });

  it("rejects a stale auth_date beyond the max age window", async () => {
    const oldAuthDate = Math.floor(Date.now() / 1000) - 25 * 60 * 60; // 25h old
    const initData = await buildInitData({ authDate: oldAuthDate });
    const result = await verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale auth_date");
  });

  it("accepts a custom maxAgeSeconds within bounds", async () => {
    const authDate = Math.floor(Date.now() / 1000) - 60; // 1 minute old
    const initData = await buildInitData({ authDate });
    const result = await verifyTelegramInitData(initData, BOT_TOKEN, 30);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale auth_date");
  });

  it("rejects an auth_date implausibly far in the future", async () => {
    const futureAuthDate = Math.floor(Date.now() / 1000) + 3600;
    const initData = await buildInitData({ authDate: futureAuthDate });
    const result = await verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale auth_date");
  });

  it("rejects missing initData", async () => {
    const result = await verifyTelegramInitData("", BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it("rejects when hash field is missing entirely", async () => {
    const initData = await buildInitData();
    const params = new URLSearchParams(initData);
    params.delete("hash");
    const result = await verifyTelegramInitData(params.toString(), BOT_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing hash");
  });

  it("rejects when the server has no configured bot token", async () => {
    const initData = await buildInitData();
    const result = await verifyTelegramInitData(initData, undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("server not configured for Telegram");
  });

  it("rejects a malformed user field", async () => {
    const initData = await buildInitData({ extraFields: { user: "not-json" } });
    const result = await verifyTelegramInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });
});
