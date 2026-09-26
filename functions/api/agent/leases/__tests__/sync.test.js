import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../../lib/__tests__/fake-supabase.js";
import { decryptSecret } from "../../../../lib/crypto.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));

const { onRequestPost, validateSlots, MAX_SLOT_LIFETIME_MS } = await import("../sync.js");

const KEY = "b".repeat(64);
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key", VPN_SECRETS_ENCRYPTION_KEY: KEY };
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PW = "Zx9-test-password-not-real";
const soon = (ms = 15 * 60 * 1000) => new Date(Date.now() + ms).toISOString();

function req(body, auth = "Bearer node-key") {
  return new Request("https://example.test/api/agent/leases/sync", {
    method: "POST",
    headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { sha256Hex } = await import("../../../../lib/crypto.js");
  db = makeFakeSupabase({ nodes: [{ node_id: "node-1", api_key_hash: await sha256Hex("node-key"), revoked_at: null }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/agent/leases/sync", () => {
  it("rejects an unauthenticated node", async () => {
    const res = await onRequestPost({ env, request: req({ slots: [] }, null) });
    expect(res.status).toBe(401);
  });

  it("stores a newly applied generation encrypted and makes it active (leasable)", async () => {
    const res = await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 1, valid_until: soon(), vless_uuid: UUID, hysteria2_password: PW }] }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots).toEqual([{ slot: 0, generation: 1, state: "active" }]);
    const [row] = db._tables.node_lease_slots;
    expect(JSON.stringify(row)).not.toContain(PW);
    expect(JSON.stringify(row)).not.toContain(UUID);
    expect(JSON.parse(await decryptSecret(row.credential_ciphertext, row.credential_nonce, KEY))).toEqual({ vless_uuid: UUID, hysteria2_password: PW });
    // Never echoes secrets back.
    expect(JSON.stringify(body)).not.toContain(PW);
  });

  it("asks for the secret when a new generation arrives without one", async () => {
    const res = await onRequestPost({ env, request: req({ slots: [{ slot: 3, generation: 2, valid_until: soon() }] }) });
    expect((await res.json()).need_secret).toEqual([3]);
    expect(db._tables.node_lease_slots).toHaveLength(0);
  });

  it("reports revoked slots so the agent rotates them", async () => {
    await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 1, valid_until: soon(), vless_uuid: UUID, hysteria2_password: PW }] }) });
    db._tables.node_lease_slots[0].state = "revoked";
    const res = await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 1, valid_until: soon() }] }) });
    expect((await res.json()).slots).toEqual([{ slot: 0, generation: 1, state: "revoked" }]);
  });

  it("never lets a stale generation overwrite a newer one", async () => {
    await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 5, valid_until: soon(), vless_uuid: UUID, hysteria2_password: PW }] }) });
    await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 4, valid_until: soon(), vless_uuid: UUID, hysteria2_password: PW }] }) });
    expect(db._tables.node_lease_slots[0].generation).toBe(5);
  });

  it("drops slots the node no longer has (bounded pool)", async () => {
    await onRequestPost({ env, request: req({ slots: [0, 1].map((slot) => ({ slot, generation: 1, valid_until: soon(), vless_uuid: UUID, hysteria2_password: PW })) }) });
    await onRequestPost({ env, request: req({ slots: [{ slot: 0, generation: 1, valid_until: soon() }] }) });
    expect(db._tables.node_lease_slots.map((s) => s.slot)).toEqual([0]);
  });

  it("validates input", () => {
    expect(validateSlots({ slots: "x" }).error).toBeDefined();
    expect(validateSlots({ slots: [{ slot: 0, generation: 1, valid_until: soon(MAX_SLOT_LIFETIME_MS + 60_000) }] }).error).toMatch(/2h/);
    expect(validateSlots({ slots: [{ slot: 0, generation: 1, valid_until: soon(), vless_uuid: "nope", hysteria2_password: PW }] }).error).toBeDefined();
    expect(validateSlots({ slots: [{ slot: 1, generation: 1, valid_until: soon() }, { slot: 1, generation: 1, valid_until: soon() }] }).error).toBeDefined();
    expect(validateSlots({ slots: [{ slot: 0, generation: 0, valid_until: soon() }] }).error).toBeDefined();
  });
});

describe("POST /api/agent/leases/sync: hysteria2 obfs password", () => {
  it("stores the per-node obfs password encrypted and tells the agent", async () => {
    const res = await onRequestPost({ env, request: req({ slots: [], hysteria2_obfs_password: "obfs-secret-value-123" }) });
    const body = await res.json();
    expect(body.obfs_stored).toBe(true);
    expect(body.min_remaining_seconds).toBeGreaterThan(0);
    const [row] = db._tables.node_transport_secrets;
    expect(JSON.stringify(row)).not.toContain("obfs-secret-value-123");
    expect(await decryptSecret(row.hysteria2_obfs_ciphertext, row.hysteria2_obfs_nonce, KEY)).toBe("obfs-secret-value-123");
  });

  it("rejects a malformed obfs password", async () => {
    const res = await onRequestPost({ env, request: req({ slots: [], hysteria2_obfs_password: "short" }) });
    expect(res.status).toBe(400);
  });
});
