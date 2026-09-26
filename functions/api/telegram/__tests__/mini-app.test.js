import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestGet: overview } = await import("../overview.js");
const { onRequestPost: unlink } = await import("../unlink.js");
const { onRequestGet: listProfiles } = await import("../profiles/index.js");
const { onRequestPatch: renameDevice } = await import("../devices/[id]/index.js");
const { onRequestPost: assign } = await import("../devices/[id]/assignment.js");

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const SERVICE_KEY = "service-role-secret-value";
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN };
const uuid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const END = "2030-01-01T00:00:00.000Z";

function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}
async function initData(telegramId, { ageSeconds = 0, token = BOT_TOKEN } = {}) {
  const fields = {
    user: JSON.stringify({ id: telegramId, username: "tg" }),
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
  };
  const dcs = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(token));
  return new URLSearchParams({ ...fields, hash: hex(await hmac(new Uint8Array(secret), enc.encode(dcs))) }).toString();
}

function req(path, init, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (init) headers["X-Telegram-Init-Data"] = init;
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (request, params = {}) => ({ env, request, params });

function seed() {
  return makeFakeSupabase({
    customer_accounts: [
      { id: "acct-1", stripe_customer_id: "cus_secret1" },
      { id: "acct-2", stripe_customer_id: "cus_secret2" },
    ],
    account_members: [
      { id: 1, account_id: "acct-1", user_id: "user-1", role: "owner" },
      { id: 2, account_id: "acct-2", user_id: "user-2", role: "owner" },
    ],
    subscriptions: [
      { id: 1, account_id: "acct-1", name: "Personal", stripe_subscription_id: "sub_secret1", status: "active", current_period_end: END, extra_seats: 3, created_at: "2026-01-01" },
      { id: 2, account_id: "acct-2", name: "Other", stripe_subscription_id: "sub_secret2", status: "active", current_period_end: END, extra_seats: 0, created_at: "2026-01-01" },
    ],
    devices: [
      { id: uuid(1), account_id: "acct-1", user_id: "user-1", name: "Phone", status: "ACTIVE", subscription_id: 1, created_at: "2026-02-01", auth_session_id: "sess-secret" },
      { id: uuid(2), account_id: "acct-2", user_id: "user-2", name: "Their laptop", status: "ACTIVE", subscription_id: 2, created_at: "2026-02-02" },
    ],
    connection_profiles: [
      { id: uuid(11), account_id: "acct-1", name: "Fast", enabled: true, routing_mode: "DIRECT", preferred_exit_location_id: uuid(21) },
      { id: uuid(12), account_id: "acct-2", name: "Theirs", enabled: true, routing_mode: "AUTO" },
    ],
    device_profile_assignments: [
      { device_id: uuid(1), profile_id: uuid(11) },
      { device_id: uuid(2), profile_id: uuid(12) },
    ],
    telegram_links: [
      { user_id: "user-1", telegram_user_id: 42, telegram_username: "tg" },
      { user_id: "user-2", telegram_user_id: 43, telegram_username: "other" },
    ],
  });
}

beforeEach(() => {
  db = seed();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Mini App authentication", () => {
  it("rejects a missing initData header", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", null)));
    expect(res.status).toBe(401);
  });

  it("rejects initData signed with another bot token", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(42, { token: "999:wrong" }))));
    expect(res.status).toBe(401);
  });

  it("rejects tampered initData", async () => {
    const good = await initData(42);
    const tampered = good.replace("%22id%22%3A42", "%22id%22%3A43");
    expect(tampered).not.toBe(good);
    const res = await overview(ctx(req("/api/telegram/overview", tampered)));
    expect(res.status).toBe(401);
  });

  it("rejects expired initData (older than 24h)", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(42, { ageSeconds: 25 * 3600 }))));
    expect(res.status).toBe(401);
  });

  it("returns 403 not_linked for a valid but unlinked Telegram user", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(777))));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_linked");
  });

  it("serves the overview for valid, linked initData", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(42))));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriptions).toEqual([
      expect.objectContaining({ id: "1", name: "Personal", capacity: 6, used: 1 }),
    ]);
    expect(body.devices).toEqual([expect.objectContaining({ id: uuid(1), name: "Phone", profileId: uuid(11) })]);
    expect(body.profiles.map((p) => p.name)).toEqual(["Fast"]);
    expect(body.plan).toEqual({ includedDevices: 3, devicesPerPack: 3 });
  });
});

describe("cross-account isolation", () => {
  it("only shows the caller's own account", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(43))));
    const body = await res.json();
    expect(body.devices.map((d) => d.id)).toEqual([uuid(2)]);
    expect(body.profiles.map((p) => p.id)).toEqual([uuid(12)]);
    const profiles = await (await listProfiles(ctx(req("/api/telegram/profiles", await initData(43))))).json();
    expect(profiles.profiles.map((p) => p.id)).toEqual([uuid(12)]);
  });

  it("cannot rename another account's device", async () => {
    const res = await renameDevice(
      ctx(req(`/api/telegram/devices/${uuid(2)}`, await initData(42), { method: "PATCH", body: { name: "Mine now" } }), { id: uuid(2) })
    );
    expect(res.status).toBe(404);
    const theirs = await (await overview(ctx(req("/api/telegram/overview", await initData(43))))).json();
    expect(theirs.devices[0].name).toBe("Their laptop");
  });

  it("cannot assign another account's profile, nor assign to another account's device", async () => {
    const init = await initData(42);
    const foreignProfile = await assign(
      ctx(req(`/api/telegram/devices/${uuid(1)}/assignment`, init, { method: "POST", body: { profileId: uuid(12) } }), { id: uuid(1) })
    );
    expect(foreignProfile.status).toBe(403);
    const foreignDevice = await assign(
      ctx(req(`/api/telegram/devices/${uuid(2)}/assignment`, init, { method: "POST", body: { profileId: uuid(11) } }), { id: uuid(2) })
    );
    expect(foreignDevice.status).toBe(404);
  });

  it("unlink removes only the caller's link", async () => {
    const res = await unlink(ctx(req("/api/telegram/unlink", await initData(42), { method: "POST" })));
    expect(res.status).toBe(200);
    expect((await overview(ctx(req("/api/telegram/overview", await initData(42))))).status).toBe(403);
    expect((await overview(ctx(req("/api/telegram/overview", await initData(43))))).status).toBe(200);
  });
});

describe("no secret leakage", () => {
  it("never returns tokens, keys, billing ids, session ids or email", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(42))));
    const text = await res.text();
    for (const secret of [BOT_TOKEN, SERVICE_KEY, "cus_secret", "sub_secret", "sess-secret", "email", "stripe", "subscribeUrl", "setupUrl"]) {
      expect(text).not.toContain(secret);
    }
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not echo the reason or the token on auth failure", async () => {
    const res = await overview(ctx(req("/api/telegram/overview", await initData(42, { token: "999:wrong" }))));
    const text = await res.text();
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain("signature");
  });
});

describe("write freshness", () => {
  it("reads accept initData up to 24h old but writes require one signed within 1h", async () => {
    const old = await initData(42, { ageSeconds: 2 * 3600 });
    expect((await overview(ctx(req("/api/telegram/overview", old)))).status).toBe(200);
    const res = await renameDevice(
      ctx(req(`/api/telegram/devices/${uuid(1)}`, old, { method: "PATCH", body: { name: "Renamed" } }), { id: uuid(1) })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("reopen_required");
  });

  it("accepts a write with fresh initData", async () => {
    const res = await renameDevice(
      ctx(req(`/api/telegram/devices/${uuid(1)}`, await initData(42, { ageSeconds: 30 * 60 }), { method: "PATCH", body: { name: "Renamed" } }), { id: uuid(1) })
    );
    expect(res.status).toBe(200);
    const body = await (await overview(ctx(req("/api/telegram/overview", await initData(42))))).json();
    expect(body.devices[0].name).toBe("Renamed");
  });

  it("assigns a profile with fresh initData", async () => {
    db = seed();
    const res = await assign(
      ctx(req(`/api/telegram/devices/${uuid(1)}/assignment`, await initData(42), { method: "POST", body: { profileId: uuid(11) } }), { id: uuid(1) })
    );
    expect(res.status).toBe(200);
  });
});
