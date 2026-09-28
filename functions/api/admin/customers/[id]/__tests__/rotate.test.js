import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const vpnAccountsEq = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      // getVpnAccountsForUser does select(...).eq("user_id", userId) with no
      // .maybeSingle() — a user can have 2+ vpn_accounts rows.
      if (table === "vpn_accounts") return { select: vi.fn().mockReturnThis(), eq: vpnAccountsEq };
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
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
  vpnAccountsEq.mockReset().mockResolvedValue({ data: [{ id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1" }], error: null });
  rpc.mockReset().mockResolvedValue({ data: { status: "ok", jobs_enqueued: 1 }, error: null });
});

describe("POST /api/admin/customers/:id/rotate", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the user has no vpn_account", async () => {
    vpnAccountsEq.mockResolvedValue({ data: [], error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a readonly admin and does not call the RPC", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls admin_insert_jobs_with_audit once with a ROTATE_SUBSCRIPTION_TOKEN job and audit metadata", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "admin_insert_jobs_with_audit",
      expect.objectContaining({
        p_job_type: "ROTATE_SUBSCRIPTION_TOKEN",
        p_jobs: [expect.objectContaining({ node_id: "node-1", vpn_account_id: 1 })],
        p_action: "admin.rotate_subscription",
        p_target_type: "vpn_account",
      })
    );
  });

  it("does not 500 when the user has 2+ provisioned devices (the repro this fix targets)", async () => {
    vpnAccountsEq.mockResolvedValue({
      data: [
        { id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1" },
        { id: 2, node_id: "node-1", vpn_user_id: "vpn-user-test-2" },
      ],
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1].p_jobs).toHaveLength(2);
  });

  // F-39 round 2 atomicity: the mutation (job rows) and the audit row are
  // written by a single RPC/transaction. If that RPC fails, the route must
  // not report success and must not have made any separate mutation or
  // audit write of its own -- there is no split-brain state to produce
  // because there is only one write call in total.
  it("on RPC failure, returns an error and makes no other database write", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "simulated transaction failure" } });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(500);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
