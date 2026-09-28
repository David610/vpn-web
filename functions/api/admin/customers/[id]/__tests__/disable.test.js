import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const membersEq = vi.fn(); // account_members.eq("user_id", ...).maybeSingle() AND .eq("account_id", ...) list
const membersMaybeSingle = vi.fn();
const vpnAccountsIn = vi.fn();
const rpc = vi.fn();
const updateUserById = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims, admin: { updateUserById } },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "account_members") {
        // getAccountForUser: select(...).eq("user_id", userId).maybeSingle()
        // getAccountMembers (via getAccountVpnAccounts): select(...).eq("account_id", accountId) — a list
        const builder = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col) => {
            if (col === "user_id") return { maybeSingle: membersMaybeSingle };
            return membersEq();
          }),
        };
        return builder;
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn().mockReturnThis(), in: vpnAccountsIn };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../disable.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1/disable", {
    method: "POST",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  membersMaybeSingle.mockReset().mockResolvedValue({ data: { account_id: "acct-1", role: "owner" }, error: null });
  membersEq.mockReset().mockResolvedValue({ data: [{ user_id: "user-1", role: "owner" }], error: null });
  vpnAccountsIn.mockReset().mockResolvedValue({
    data: [{ id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: true }],
    error: null,
  });
  rpc.mockReset().mockResolvedValue({ data: { status: "ok", jobs_enqueued: 1 }, error: null });
  updateUserById.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/customers/:id/disable", () => {
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

  it("returns 403 for a readonly admin and does not call the RPC", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  // F-07/F-39: the suspend flag, the DISABLE_USER job fan-out, and the audit
  // row are now one atomic RPC call (admin_set_account_suspension_with_audit,
  // see 20261008000000_admin_audit_transactional.sql) instead of three
  // separate supabase-js writes.
  it("suspends the account, revokes every device, bans the user, and audits it atomically", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("admin_set_account_suspension_with_audit", {
      p_account_id: "acct-1",
      p_suspended: true,
      p_jobs: [
        expect.objectContaining({ node_id: "node-1", vpn_account_id: 1, vpn_user_id: "vpn-user-test-1" }),
      ],
      p_admin_user_id: "admin-1",
      p_action: "admin.disable_account",
      p_audit_metadata: { user_id: "user-1", device_count: 1 },
    });
    expect(updateUserById).toHaveBeenCalledWith("user-1", expect.objectContaining({ ban_duration: expect.any(String) }));
  });

  it("does not 500 when the account has 2+ provisioned devices (the repro this fix targets)", async () => {
    vpnAccountsIn.mockResolvedValue({
      data: [
        { id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: true },
        { id: 2, node_id: "node-1", vpn_user_id: "vpn-user-test-2", user_id: "user-1", enabled: true },
      ],
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    const jobs = rpc.mock.calls[0][1].p_jobs;
    expect(jobs).toHaveLength(2);
  });

  it("skips already-disabled devices", async () => {
    vpnAccountsIn.mockResolvedValue({
      data: [{ id: 1, node_id: "node-1", vpn_user_id: "vpn-user-test-1", user_id: "user-1", enabled: false }],
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1].p_jobs).toEqual([]);
  });

  it("returns 500 and does not ban when the RPC reports failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
