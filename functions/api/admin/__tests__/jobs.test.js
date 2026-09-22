import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
let jobsQuery;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "provisioning_jobs") return jobsQuery();
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../jobs.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(query = "") {
  return new Request(`https://example.test/api/admin/jobs${query}`, { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  jobsQuery = () => ({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve) =>
      resolve({
        data: [{ id: 5, job_type: "CREATE_USER", status: "failed", node_id: "node-1", vpn_account_id: 1, created_at: "t1", claimed_at: "t2", completed_at: null, result: { subscription_url: "secret" } }],
        error: null,
      }),
  });
});

describe("GET /api/admin/jobs", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("redacts subscription_url in every job's result", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
  });

  it("caps the query at 200 rows", async () => {
    const limitSpy = vi.fn().mockReturnThis();
    jobsQuery = () => ({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: limitSpy,
      then: (resolve) => resolve({ data: [], error: null }),
    });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    expect(limitSpy).toHaveBeenCalledWith(200);
  });
});
