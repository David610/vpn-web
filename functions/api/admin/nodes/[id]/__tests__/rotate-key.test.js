import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodeMaybeSingle = vi.fn();
const auditInsert = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "nodes") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: nodeMaybeSingle };
      }
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../rotate-key.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/nodes/node-1/rotate-key", {
    method: "POST",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "READY" }, error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset().mockResolvedValue({ data: { status: "ok" }, error: null });
});

describe("POST /api/admin/nodes/:id/rotate-key", () => {
  it("returns 403 for a readonly admin without calling the RPC", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "node-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 404 when the node does not exist", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("refuses to rotate a QUARANTINED node's key (its key is already revoked)", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "QUARANTINED" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rotates the key, returns the new plaintext key exactly once, and audits without the key", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.apiKey).toBe("string");
    expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/);

    expect(rpc).toHaveBeenCalledWith("rotate_node_key", {
      p_node_id: "node-1",
      p_new_key_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The hash sent to the RPC must not be the plaintext key itself.
    expect(rpc.mock.calls[0][1].p_new_key_hash).not.toBe(body.apiKey);

    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.node_key_rotated", target_id: "node-1", metadata: {} })
    );
    const auditedJson = JSON.stringify(auditInsert.mock.calls[0][0]);
    expect(auditedJson).not.toContain(body.apiKey);
  });
});
