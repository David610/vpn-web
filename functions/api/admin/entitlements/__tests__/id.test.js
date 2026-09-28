import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const rpc = vi.fn();
const getEffectiveEntitlement = vi.fn(async () => ({ source: "admin_grant", seatLimit: 5 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
  })),
}));

vi.mock("../../../../lib/accounts.js", async () => {
  const actual = await vi.importActual("../../../../lib/accounts.js");
  return { ...actual, getEffectiveEntitlement };
});

const syncAccountProvisioningToEntitlement = vi.fn(async () => {});
vi.mock("../../../../lib/provision-entitlement.js", () => ({
  syncAccountProvisioningToEntitlement,
}));

const { onRequestDelete } = await import("../[id].js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/entitlements/grant-1", {
    method: "DELETE",
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  rpc.mockReset().mockResolvedValue({ data: { status: "ok", account_id: "acct-1" }, error: null });
  syncAccountProvisioningToEntitlement.mockClear();
  getEffectiveEntitlement.mockClear();
});

describe("DELETE /api/admin/entitlements/:id", () => {
  it("returns 403 for a readonly admin and does not call the RPC", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestDelete({ env, request: makeRequest(), params: { id: "grant-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls admin_revoke_entitlement_with_audit once and syncs provisioning after", async () => {
    const res = await onRequestDelete({ env, request: makeRequest(), params: { id: "grant-1" } });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "admin_revoke_entitlement_with_audit",
      expect.objectContaining({ p_grant_id: "grant-1", p_admin_user_id: "admin-1" })
    );
    expect(syncAccountProvisioningToEntitlement).toHaveBeenCalledWith(
      expect.anything(),
      "acct-1",
      expect.anything(),
      expect.stringContaining("admin-revoke:"),
      env
    );
  });

  it("returns 404 when the RPC reports the grant does not exist", async () => {
    rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    const res = await onRequestDelete({ env, request: makeRequest(), params: { id: "missing" } });
    expect(res.status).toBe(404);
    expect(syncAccountProvisioningToEntitlement).not.toHaveBeenCalled();
  });

  it("returns ok:true,duplicate:true without re-syncing when already revoked", async () => {
    rpc.mockResolvedValue({ data: { status: "duplicate", account_id: "acct-1" }, error: null });
    const res = await onRequestDelete({ env, request: makeRequest(), params: { id: "grant-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(syncAccountProvisioningToEntitlement).not.toHaveBeenCalled();
  });

  // F-39 round 2 atomicity: the admin_entitlements revoke and the audit row
  // are written by a single RPC/transaction. If that RPC fails, the route
  // must not report success and must never run the downstream provisioning
  // sync for a revoke that never actually happened.
  it("on RPC failure, returns an error and never runs the downstream provisioning sync", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "simulated transaction failure" } });
    const res = await onRequestDelete({ env, request: makeRequest(), params: { id: "grant-1" } });
    expect(res.status).toBe(500);
    expect(syncAccountProvisioningToEntitlement).not.toHaveBeenCalled();
  });
});
