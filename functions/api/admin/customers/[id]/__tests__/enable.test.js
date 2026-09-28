import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const membersMaybeSingle = vi.fn();
const membersEq = vi.fn();
const customerAccountsEq = vi.fn();
const vpnAccountsIn = vi.fn();
const jobInsert = vi.fn();
const auditInsert = vi.fn();
const updateUserById = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims, admin: { updateUserById } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "account_members") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col) => {
            if (col === "user_id") return { maybeSingle: membersMaybeSingle };
            return membersEq();
          }),
        };
      }
      if (table === "customer_accounts") {
        return { update: vi.fn().mockReturnThis(), eq: customerAccountsEq };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn().mockReturnThis(), in: vpnAccountsIn };
      }
      if (table === "provisioning_jobs") return { insert: jobInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../enable.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1/enable", {
    method: "POST",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  membersMaybeSingle.mockReset().mockResolvedValue({ data: { account_id: "acct-1", role: "owner" }, error: null });
  membersEq.mockReset().mockResolvedValue({ data: [{ user_id: "user-1", role: "owner" }], error: null });
  customerAccountsEq.mockReset().mockResolvedValue({ error: null });
  vpnAccountsIn.mockReset().mockResolvedValue({
    data: [{ id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: false }],
    error: null,
  });
  jobInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
  updateUserById.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/customers/:id/enable", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user has no account", async () => {
    membersMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a readonly admin and does not insert a job", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(jobInsert).not.toHaveBeenCalled();
  });

  it("clears suspension, re-enables every disabled device, unbans, and audits it", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(customerAccountsEq).toHaveBeenCalledWith("id", "acct-1");
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: "ENABLE_USER", node_id: "node-1", vpn_account_id: 1, payload: { vpn_user_id: "vpn-user-test-1" } })
    );
    expect(updateUserById).toHaveBeenCalledWith("user-1", { ban_duration: "none" });
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.enable_account", target_type: "customer_account", target_id: "acct-1" })
    );
  });

  it("does not 500 when the account has 2+ provisioned devices (the repro this fix targets)", async () => {
    vpnAccountsIn.mockResolvedValue({
      data: [
        { id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: false },
        { id: 2, node_id: "node-1", vpn_user_id: "vpn-user-test-2", user_id: "user-1", enabled: false },
      ],
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(jobInsert).toHaveBeenCalledTimes(2);
  });

  it("skips already-enabled devices", async () => {
    vpnAccountsIn.mockResolvedValue({
      data: [{ id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: true }],
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(jobInsert).not.toHaveBeenCalled();
  });
});
