import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const memberCountResult = { count: 0, error: null };
const inviteSelect = vi.fn();
const rpc = vi.fn();
const getEffectiveEntitlement = vi.fn(async () => ({ source: "admin_grant", seatLimit: 5 }));

// account_members serves two different query shapes in grant.js:
// getAccountForUser's select(...).eq(...).maybeSingle(), and the seat-count
// select(...,{head:true}).eq(...) which resolves directly without
// .maybeSingle(). A thenable chain object handles both call shapes.
function accountMembersChain() {
  const chain = {
    maybeSingle: async () => ({ data: { account_id: "acct-1", role: "owner" }, error: null }),
    then: (resolve) => resolve(memberCountResult),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "account_members") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => accountMembersChain()) })) };
      }
      if (table === "member_invites") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          gt: vi.fn(() => inviteSelect()),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
  })),
}));

vi.mock("../../../../../lib/accounts.js", async () => {
  const actual = await vi.importActual("../../../../../lib/accounts.js");
  return { ...actual, getEffectiveEntitlement };
});

const syncAccountProvisioningToEntitlement = vi.fn(async () => {});
vi.mock("../../../../../lib/provision-entitlement.js", () => ({
  syncAccountProvisioningToEntitlement,
}));

const { onRequestPost } = await import("../grant.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/admin/customers/user-1/grant", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  memberCountResult.count = 0;
  memberCountResult.error = null;
  inviteSelect.mockReset().mockResolvedValue({ data: [], error: null });
  rpc.mockReset().mockResolvedValue({
    data: { id: "grant-1", account_id: "acct-1", status: "active", seat_limit: 3, reason: "test", starts_at: "now", expires_at: null, created_at: "now" },
    error: null,
  });
  syncAccountProvisioningToEntitlement.mockClear();
});

describe("POST /api/admin/customers/:id/grant", () => {
  it("returns 403 for a readonly admin and does not call the RPC", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest({ reason: "support" }), params: { id: "user-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls admin_grant_entitlement_with_audit once and returns the grant", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ reason: "support", seat_limit: 5 }), params: { id: "user-1" } });
    expect(res.status).toBe(201);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "admin_grant_entitlement_with_audit",
      expect.objectContaining({ p_account_id: "acct-1", p_seat_limit: 5, p_reason: "support", p_admin_user_id: "admin-1" })
    );
    const body = await res.json();
    expect(body.grant.id).toBe("grant-1");
  });

  // F-39 round 2 atomicity: the admin_entitlements insert and the audit row
  // are written by a single RPC/transaction. If that RPC fails, the route
  // must not report success, and downstream provisioning sync must never
  // run for a grant that was never actually inserted.
  it("on RPC failure, returns an error and never runs the downstream provisioning sync", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "simulated transaction failure" } });
    const res = await onRequestPost({ env, request: makeRequest({ reason: "support" }), params: { id: "user-1" } });
    expect(res.status).toBe(500);
    expect(syncAccountProvisioningToEntitlement).not.toHaveBeenCalled();
  });
});
