import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
let nodesSelect;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "nodes") return { select: nodesSelect };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../nodes.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/nodes", { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
});

describe("GET /api/admin/nodes", () => {
  it("classifies a node seen 10s ago as online", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("online");
  });

  it("classifies a node seen 90s ago as degraded", async () => {
    const stale = new Date(Date.now() - 90_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: stale, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("degraded");
  });

  it("classifies a node seen 200s ago as offline", async () => {
    const old = new Date(Date.now() - 200_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: old, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });

  it("classifies a node with no last_seen_at as offline", async () => {
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: null, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });

  it("classifies a revoked node as revoked regardless of last_seen_at", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const revokedDate = new Date(Date.now() - 30_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: revokedDate }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("revoked");
  });
});
