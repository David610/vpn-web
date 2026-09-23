import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const range = vi.fn();
let eq = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: adminMaybeSingle,
        };
      }
      if (table === "provisioning_jobs") {
        const chain = {
          select: vi.fn(() => chain),
          order: vi.fn(() => chain),
          eq: vi.fn((...args) => {
            eq(...args);
            return chain;
          }),
          range,
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../jobs.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(query = "") {
  return new Request(`https://example.test/api/admin/jobs${query}`, {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({
    data: { claims: { sub: "admin-1", aal: "aal2" } },
    error: null,
  });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  eq = vi.fn();
  range.mockReset().mockResolvedValue({
    data: [{
      id: 5,
      job_type: "CREATE_USER",
      status: "failed",
      node_id: "node-1",
      vpn_account_id: 1,
      created_at: "t1",
      claimed_at: "t2",
      completed_at: null,
      result: { subscription_url: "secret" },
    }],
    count: 121,
    error: null,
  });
});

describe("GET /api/admin/jobs", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("redacts secrets and returns pagination metadata", async () => {
    const res = await onRequestGet({ env, request: makeRequest("?page=3&per_page=40") });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
    expect(body).toMatchObject({
      page: 3,
      perPage: 40,
      total: 121,
      totalPages: 4,
    });
    expect(range).toHaveBeenCalledWith(80, 119);
  });

  it("applies a validated status filter", async () => {
    await onRequestGet({ env, request: makeRequest("?status=failed") });
    expect(eq).toHaveBeenCalledWith("status", "failed");
  });

  it("rejects unknown status values", async () => {
    const res = await onRequestGet({ env, request: makeRequest("?status=wat") });
    expect(res.status).toBe(400);
    expect(range).not.toHaveBeenCalled();
  });

  it("caps page size at 100", async () => {
    await onRequestGet({ env, request: makeRequest("?per_page=999") });
    expect(range).toHaveBeenCalledWith(0, 99);
  });
});
