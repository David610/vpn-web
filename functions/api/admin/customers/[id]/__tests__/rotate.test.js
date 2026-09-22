import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const vpnMaybeSingle = vi.fn();
const jobInsert = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "vpn_accounts") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vpnMaybeSingle };
      if (table === "provisioning_jobs") return { insert: jobInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../rotate.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1/rotate", {
    method: "POST",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  vpnMaybeSingle.mockReset().mockResolvedValue({ data: { id: 1, node_id: "node-1" }, error: null });
  jobInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/customers/:id/rotate", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user has no vpn_account", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a readonly admin and does not insert a job", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(jobInsert).not.toHaveBeenCalled();
  });

  it("inserts a ROTATE_SUBSCRIPTION_TOKEN job and an audit row", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: "ROTATE_SUBSCRIPTION_TOKEN", node_id: "node-1", vpn_account_id: 1 })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.rotate_subscription", target_type: "vpn_account", target_id: "1" })
    );
  });
});
