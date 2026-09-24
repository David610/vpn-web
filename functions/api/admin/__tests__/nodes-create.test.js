import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodesInsert = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "nodes") return { insert: nodesInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../nodes.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/admin/nodes", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodesInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/nodes", () => {
  it("returns 400 for an invalid nodeId", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ nodeId: "DE FRA 3!" }) });
    expect(res.status).toBe(400);
    expect(nodesInsert).not.toHaveBeenCalled();
  });

  it("returns 403 for a readonly admin and does not insert a node", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest({ nodeId: "de-fra-3" }) });
    expect(res.status).toBe(403);
    expect(nodesInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when the node id already exists", async () => {
    nodesInsert.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const res = await onRequestPost({ env, request: makeRequest({ nodeId: "de-fra-3" }) });
    expect(res.status).toBe(409);
  });

  it("creates a PROVISIONING node with no api_key_hash and a hashed enrollment token, returning the raw token once", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ nodeId: "de-fra-3", role: "RELAY", locationId: "loc-1" }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nodeId).toBe("de-fra-3");
    expect(typeof body.enrollmentToken).toBe("string");
    expect(body.enrollmentToken.length).toBeGreaterThan(32);

    const insertedRow = nodesInsert.mock.calls[0][0];
    expect(insertedRow).toMatchObject({
      node_id: "de-fra-3",
      role: "RELAY",
      location_id: "loc-1",
      lifecycle_state: "PROVISIONING",
    });
    expect(insertedRow).not.toHaveProperty("api_key_hash");
    // Only the hash is stored — never the raw token itself.
    expect(insertedRow.enrollment_token_hash).not.toBe(body.enrollmentToken);
    expect(insertedRow.enrollment_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.create_pending_node", target_id: "de-fra-3" })
    );
  });

  it("defaults role to EXIT and locationId to null when omitted", async () => {
    await onRequestPost({ env, request: makeRequest({ nodeId: "de-fra-4" }) });
    expect(nodesInsert.mock.calls[0][0]).toMatchObject({ role: "EXIT", location_id: null });
  });
});
