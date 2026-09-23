import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: adminMaybeSingle,
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../overview.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/overview", {
    headers: { Authorization: "Bearer good" },
  });
}

const snapshot = {
  customers: { total: 10, active: 7, trialing: 2, past_due: 1, canceled: 3 },
  members: {
    active: 18,
    pending_invites: 2,
    admin_grants: 1,
    paid_extra_seats: 3,
  },
  vpn: { accounts: 15, enabled: 13, disabled: 2 },
  jobs: { pending: 4, claimed: 1, failed: 2 },
  nodes: { online: 1, offline: 2 },
  usage: {
    download_bps: 12_000_000,
    upload_bps: 3_000_000,
    month_download_bytes: 4000,
    month_upload_bytes: 1000,
    month_total_bytes: 5000,
  },
  alerts: { open: 2 },
  abuse: { open: 1 },
};

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({
    data: { claims: { sub: "admin-1", aal: "aal2" } },
    error: null,
  });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  rpc.mockReset().mockResolvedValue({ data: snapshot, error: null });
});

describe("GET /api/admin/overview", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the single DB snapshot unchanged", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
    expect(rpc).toHaveBeenCalledWith("admin_overview_snapshot");
  });

  it("returns 500 when the snapshot query fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
  });
});
