import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodeMaybeSingle = vi.fn();
const auditInsert = vi.fn();
const createNodeRevision = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
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

vi.mock("../../../../../lib/node-revisions.js", () => ({ createNodeRevision }));

const { onRequestPost } = await import("../revisions.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/admin/nodes/node-1/revisions", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1" }, error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
  createNodeRevision.mockReset().mockResolvedValue({ revision: 4 });
});

describe("POST /api/admin/nodes/:id/revisions", () => {
  it("pushes a new revision and returns it", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ config: { role: "EXIT" }, reason: "manual test" }),
      params: { id: "node-1" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, revision: 4 });
    expect(createNodeRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nodeId: "node-1",
        config: { role: "EXIT" },
        reason: "manual test",
        createdBy: "admin-1",
      })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.push_node_revision",
        target_id: "node-1",
        metadata: { revision: 4, reason: "manual test" },
      })
    );
  });

  it("returns 400 when config is missing", async () => {
    const res = await onRequestPost({ env, request: makeRequest({}), params: { id: "node-1" } });
    expect(res.status).toBe(400);
    expect(createNodeRevision).not.toHaveBeenCalled();
  });

  it("returns 400 instead of throwing when the parsed JSON body is literally null", async () => {
    const res = await onRequestPost({ env, request: makeRequest(null), params: { id: "node-1" } });
    expect(res.status).toBe(400);
    expect(createNodeRevision).not.toHaveBeenCalled();
  });

  it("returns 400 when config is not an object", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ config: "not-an-object" }),
      params: { id: "node-1" },
    });
    expect(res.status).toBe(400);
    expect(createNodeRevision).not.toHaveBeenCalled();
  });

  it("returns 403 for a readonly admin and does not push a revision", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest({ config: {} }), params: { id: "node-1" } });
    expect(res.status).toBe(403);
    expect(createNodeRevision).not.toHaveBeenCalled();
  });

  it("returns 404 when the node does not exist", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest({ config: {} }), params: { id: "missing" } });
    expect(res.status).toBe(404);
    expect(createNodeRevision).not.toHaveBeenCalled();
  });
});
