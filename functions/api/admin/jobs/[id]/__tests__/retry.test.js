import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const jobMaybeSingle = vi.fn();
const jobInsert = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "provisioning_jobs") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: jobMaybeSingle, insert: jobInsert };
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../retry.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/jobs/5/retry", { method: "POST", headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  jobMaybeSingle.mockReset().mockResolvedValue({
    data: { id: 5, job_type: "CREATE_USER", status: "failed", node_id: "node-1", vpn_account_id: 1, payload: { user_id: "user-1" } },
    error: null,
  });
  jobInsert.mockReset().mockResolvedValue({ error: null });
  auditInsert.mockReset().mockResolvedValue({ error: null });
});

describe("POST /api/admin/jobs/:id/retry", () => {
  it("returns 400 when the job is not failed", async () => {
    jobMaybeSingle.mockResolvedValue({ data: { id: 5, status: "done" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a readonly admin and does not insert a job", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(403);
    expect(jobInsert).not.toHaveBeenCalled();
  });

  it("inserts a new job copying the failed job's payload, and an audit row", async () => {
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(200);
    expect(jobInsert).toHaveBeenCalledWith(
      expect.objectContaining({ job_type: "CREATE_USER", node_id: "node-1", vpn_account_id: 1, payload: { user_id: "user-1" } })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.retry_job" })
    );
  });

  it("returns 500 when the post-insert re-fetch finds no row", async () => {
    jobMaybeSingle
      .mockReset()
      .mockResolvedValueOnce({
        data: { id: 5, job_type: "CREATE_USER", status: "failed", node_id: "node-1", vpn_account_id: 1, payload: { user_id: "user-1" } },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "5" } });
    expect(res.status).toBe(500);
    expect(auditInsert).not.toHaveBeenCalled();
  });
});
