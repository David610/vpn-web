import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ rpc, from })) }));
vi.mock("../../../lib/node-auth.js", () => ({ authenticateNode: vi.fn(async () => "node-1") }));
vi.mock("../../../lib/crypto.js", () => ({ decryptSecret: vi.fn(async () => JSON.stringify({
  vless_uuid: "018f4f18-8b5d-7c21-9f2b-0f8a7c6d5e4f", hysteria2_password: "secret",
})) }));

const { onRequestGet, onRequestPost } = await import("../authorizations.js");
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "service" };
const projected = {
  principal_id: `ext_${"a".repeat(43)}`, credential_id: `cred_${"b".repeat(43)}`,
  credential_class: "compatibility", class: "compatibility", logical_route_id: "route_de_fast",
  valid_from: "2026-10-01T00:00:00Z", valid_until: "2026-10-08T00:00:00Z", revoked: false,
  credential_ciphertext: "cipher", credential_nonce: "nonce",
};

function query(result) {
  return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue(result), in: vi.fn().mockResolvedValue(result) };
}

beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  from.mockImplementation((table) => table === "compatibility_authorizations"
    ? query({ data: [projected], error: null })
    : query({ data: [{ device_id: "device-1", principal_id: projected.principal_id, revoked_at: null }], error: null }));
  rpc.mockImplementation(async (name) => {
    if (name === "device_entitlement") return { data: [{ entitled: true }], error: null };
    if (name === "get_compatibility_authorization_snapshot") {
      return { data: [{ snapshot_revision: 5, authorizations: [projected] }], error: null };
    }
    if (name === "ack_compatibility_authorization_snapshot") {
      return { data: [{ desired_revision: 6, applied_revision: 5, state: "pending" }], error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("agent authorization schema negotiation", () => {
  it("preserves the exact legacy envelope and logical route field", async () => {
    const res = await onRequestGet({ env, request: new Request("https://x.test/api/agent/authorizations") });
    const body = await res.json();
    expect(body).not.toHaveProperty("schema_version");
    expect(body).not.toHaveProperty("snapshot_revision");
    expect(body.authorizations[0]).toEqual(expect.objectContaining({
      principal_id: projected.principal_id, credential_id: projected.credential_id,
      class: "compatibility", logical_route_id: "route_de_fast", revoked: false,
    }));
  });

  it("returns v2 snapshot metadata and omits route/customer identity", async () => {
    const res = await onRequestGet({ env, request: new Request("https://x.test/api/agent/authorizations?schema=2") });
    const body = await res.json();
    expect(body).toMatchObject({ schema_version: 2, snapshot_revision: 5 });
    expect(body.authorizations[0]).not.toHaveProperty("logical_route_id");
    expect(JSON.stringify(body)).not.toMatch(/account|customer|billing|subscription_token/);
  });

  it("returns revision zero as a supported initial empty v2 snapshot", async () => {
    rpc.mockResolvedValueOnce({ data: [{ snapshot_revision: 0, authorizations: [] }], error: null });
    const res = await onRequestGet({ env, request: new Request("https://x.test/api/agent/authorizations?schema=2") });
    expect(await res.json()).toEqual({ schema_version: 2, snapshot_revision: 0, authorizations: [] });
  });

  it("accepts an exact revision-zero ACK response as applied", async () => {
    rpc.mockResolvedValueOnce({ data: [{ desired_revision: 0, applied_revision: 0, state: "applied" }], error: null });
    const request = new Request("https://x.test/api/agent/authorizations?schema=2", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: 2, snapshot_revision: 0 }),
    });
    const res = await onRequestPost({ env, request });
    expect(rpc).toHaveBeenCalledWith("ack_compatibility_authorization_snapshot", {
      p_node_id: "node-1", p_snapshot_revision: 0,
    });
    expect(await res.json()).toEqual({ schema_version: 2, desired_revision: 0, applied_revision: 0, state: "applied" });
  });

  it("ACKs exactly the posted snapshot revision, including a stale revision", async () => {
    const request = new Request("https://x.test/api/agent/authorizations?schema=2", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: 2, snapshot_revision: 5 }),
    });
    const res = await onRequestPost({ env, request });
    expect(rpc).toHaveBeenCalledWith("ack_compatibility_authorization_snapshot", {
      p_node_id: "node-1", p_snapshot_revision: 5,
    });
    expect(await res.json()).toEqual({ schema_version: 2, desired_revision: 6, applied_revision: 5, state: "pending" });
  });

  it("rejects legacy credential-list ACKs and future revisions", async () => {
    let request = new Request("https://x.test/api/agent/authorizations?schema=2", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential_ids: [projected.credential_id] }),
    });
    expect((await onRequestPost({ env, request })).status).toBe(400);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "future_snapshot_revision" } });
    request = new Request("https://x.test/api/agent/authorizations?schema=2", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema_version: 2, snapshot_revision: 7 }),
    });
    expect((await onRequestPost({ env, request })).status).toBe(409);
  });
});
