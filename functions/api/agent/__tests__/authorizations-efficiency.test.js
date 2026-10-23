import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const from = vi.fn();
const decryptSecret = vi.fn(async () => JSON.stringify({
  vless_uuid: "018f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f", hysteria2_password: "secret",
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ rpc, from })) }));
vi.mock("../../../lib/node-auth.js", () => ({ authenticateNode: vi.fn(async () => "node-1") }));
vi.mock("../../../lib/crypto.js", () => ({ decryptSecret: (...args) => decryptSecret(...args) }));

const mod = await import("../authorizations.js");
const { onRequestGet } = mod;
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "service", VPN_SECRETS_ENCRYPTION_KEY: "k" };

function row(n) {
  return {
    principal_id: `ext_${String(n).padStart(43, "a")}`, credential_id: `cred_${String(n).padStart(43, "b")}`,
    credential_class: "compatibility", class: "compatibility", logical_route_id: "route_de_fast",
    valid_from: "2026-10-01T00:00:00Z", valid_until: "2026-10-08T00:00:00Z", revoked: false,
    credential_ciphertext: `cipher-${n}`, credential_nonce: `nonce-${n}`,
  };
}

let rows;
let entitled;
let batchAvailable;
let syncedAvailable;
let syncedRevision;

function install() {
  from.mockImplementation((table) => {
    const result = table === "external_vpn_devices"
      ? { data: rows.map((r, i) => ({ device_id: `device-${i}`, principal_id: r.principal_id, revoked_at: null })), error: null }
      : { data: rows, error: null };
    return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue(result), in: vi.fn().mockResolvedValue(result) };
  });
  rpc.mockImplementation(async (name, args) => {
    if (name === "get_compatibility_authorization_snapshot_synced") {
      if (syncedAvailable === "error") return { data: null, error: { code: "XX000", message: "boom" } };
      if (!syncedAvailable) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.get_compatibility_authorization_snapshot_synced" } };
      return { data: [{ snapshot_revision: syncedRevision, authorizations: rows }], error: null };
    }
    if (name === "get_compatibility_authorization_snapshot") return { data: [{ snapshot_revision: 9, authorizations: rows }], error: null };
    if (name === "device_entitlements_batch") {
      if (!batchAvailable) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.device_entitlements_batch" } };
      return { data: args.p_device_ids.map((id) => ({ device_id: id, entitled })), error: null };
    }
    if (name === "device_entitlement") return { data: [{ entitled }], error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
}

const get = (headers = {}) => onRequestGet({
  env,
  request: new Request("https://x.test/api/agent/authorizations?schema=2", { headers }),
});
const count = (name) => rpc.mock.calls.filter(([n]) => n === name).length;

beforeEach(() => {
  rpc.mockReset(); from.mockReset(); decryptSecret.mockClear();
  rows = Array.from({ length: 12 }, (_, i) => row(i));
  entitled = true;
  batchAvailable = true;
  syncedAvailable = false;
  syncedRevision = 10;
  mod.resetEntitlementBatchSupport?.();
  mod.resetSnapshotSyncSupport?.();
  install();
});

describe("authorization snapshot efficiency", () => {
  it("looks up entitlement for all principals in ONE rpc instead of one per principal", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(count("device_entitlements_batch")).toBe(1);
    expect(count("device_entitlement")).toBe(0);
    expect((await res.json()).authorizations).toHaveLength(12);
  });

  it("falls back to bounded per-device lookups while the batch function is not deployed", async () => {
    batchAvailable = false;
    let inFlight = 0;
    let peak = 0;
    const base = rpc.getMockImplementation();
    rpc.mockImplementation(async (name, args) => {
      if (name !== "device_entitlement") return base(name, args);
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { data: [{ entitled: true }], error: null };
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(count("device_entitlement")).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    await get();
    expect(count("device_entitlements_batch")).toBe(1); // unsupported result is remembered, not retried per poll
  });

  it("emits a strong ETag derived only from non-secret state", async () => {
    const res = await get();
    const etag = res.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(etag).not.toContain("secret");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 304 without decrypting anything when the node already has the current state", async () => {
    const etag = (await get()).headers.get("ETag");
    decryptSecret.mockClear();
    const res = await get({ "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it("changes the ETag and re-sends the snapshot when a principal loses entitlement", async () => {
    const etag = (await get()).headers.get("ETag");
    entitled = false;
    const res = await get({ "If-None-Match": etag });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).not.toBe(etag);
    expect((await res.json()).authorizations.every((a) => a.revoked === true)).toBe(true);
  });

  it("changes the ETag when a credential is re-issued under the same revision number", async () => {
    const etag = (await get()).headers.get("ETag");
    rows[3] = { ...rows[3], credential_ciphertext: "rotated", credential_nonce: "rotated-nonce" };
    install();
    expect((await get({ "If-None-Match": etag })).status).toBe(200);
  });

  it("keeps ETags of the legacy and v2 envelopes apart", async () => {
    const v2 = (await get()).headers.get("ETag");
    const legacy = await onRequestGet({ env, request: new Request("https://x.test/api/agent/authorizations") });
    expect(legacy.headers.get("ETag")).not.toBe(v2);
  });

  it("ignores a malformed If-None-Match header", async () => {
    const res = await get({ "If-None-Match": "garbage, W/\"x\"" });
    expect(res.status).toBe(200);
  });
});

describe("entitlement-aware snapshot revision (I-100)", () => {
  it("uses the synced snapshot function when present and serves its revision", async () => {
    syncedAvailable = true; syncedRevision = 42;
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).snapshot_revision).toBe(42);
    expect(count("get_compatibility_authorization_snapshot_synced")).toBe(1);
    expect(count("get_compatibility_authorization_snapshot")).toBe(0);
  });

  it("falls back to the plain snapshot read on a database without the migration, and does not retry every request", async () => {
    const first = await get();
    expect((await first.json()).snapshot_revision).toBe(9);
    await get();
    expect(count("get_compatibility_authorization_snapshot_synced")).toBe(1);
    expect(count("get_compatibility_authorization_snapshot")).toBe(2);
  });

  it("a real database error is a 500, never a silent downgrade to the plain read", async () => {
    syncedAvailable = "error";
    const res = await get();
    expect(res.status).toBe(500);
    expect(count("get_compatibility_authorization_snapshot")).toBe(0);
  });

  it("a revision bump changes the ETag so a cached 304 cannot hide a renewal", async () => {
    syncedAvailable = true; syncedRevision = 5;
    const etag = (await get()).headers.get("etag");
    syncedRevision = 6;
    const res = await get({ "If-None-Match": etag });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(etag);
  });
});
