import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
let auditQuery;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "admin_audit_log") return auditQuery();
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../audit.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/audit", { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  auditQuery = () => ({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: [{ id: 1, admin_user_id: "admin-1", action: "admin.disable_user", target_type: "vpn_account", target_id: "1", metadata: {}, created_at: "t1" }],
      error: null,
    }),
  });
});

describe("GET /api/admin/audit", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("returns audit entries in camelCase", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.entries[0]).toEqual({
      id: 1,
      adminUserId: "admin-1",
      action: "admin.disable_user",
      targetType: "vpn_account",
      targetId: "1",
      metadata: {},
      createdAt: "t1",
    });
  });
});
