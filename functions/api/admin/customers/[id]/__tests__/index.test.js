import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const getUserById = vi.fn();
let subMaybeSingle, vpnMaybeSingle, jobsOrder;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { getUserById } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "subscriptions") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: subMaybeSingle };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vpnMaybeSingle };
      }
      if (table === "provisioning_jobs") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: jobsOrder };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../index.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1", {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  getUserById.mockReset().mockResolvedValue({ data: { user: { email: "alice@example.com" } }, error: null });
  subMaybeSingle = vi.fn().mockResolvedValue({ data: { status: "active", current_period_end: "2026-10-21T00:00:00Z" }, error: null });
  vpnMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 1, vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }, error: null });
  jobsOrder = vi.fn().mockResolvedValue({
    data: [{ id: 9, job_type: "CREATE_USER", status: "done", created_at: "t1", claimed_at: "t2", completed_at: "t3", result: { subscription_url: "https://secret" } }],
    error: null,
  });
});

describe("GET /api/admin/customers/:id", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("redacts subscription_url in job history", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
  });

  it("returns null vpnAccount when the user has none", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.vpnAccount).toBeNull();
  });
});
