import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const jobsUpdate = vi.fn();
const jobsUpdateEq = vi.fn();
const alertInsert = vi.fn();

vi.mock("../../../../../lib/node-auth.js", () => ({
  authenticateNode: vi.fn(),
}));

vi.mock("../../../../../lib/resend.js", () => ({
  sendFailureAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "provisioning_jobs") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle,
          update: jobsUpdate.mockReturnValue({ eq: jobsUpdateEq }),
        };
      }
      if (table === "operational_alerts") {
        return { insert: alertInsert.mockResolvedValue({ error: null }) };
      }
      return {};
    }),
  })),
}));

const { authenticateNode } = await import("../../../../../lib/node-auth.js");
const { onRequestPost } = await import("../fail.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body = {}) {
  return new Request("https://example.test/api/agent/jobs/job-1/fail", {
    method: "POST",
    headers: { Authorization: "Bearer key" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  maybeSingle.mockReset();
  jobsUpdate.mockClear();
  jobsUpdateEq.mockReset().mockResolvedValue({ error: null });
  alertInsert.mockClear();
  authenticateNode.mockReset().mockResolvedValue("node-1");
});

describe("agent/jobs/[id]/fail", () => {
  it("marks the job failed and clears the claim token/lease", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "job-1", job_type: "CREATE_USER", payload: {}, node_id: "node-1", status: "claimed" },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest({ error: "boom" }), params: { id: "job-1" } });
    expect(res.status).toBe(200);
    expect(jobsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", claim_token: null, lease_expires_at: null })
    );
    expect(alertInsert).toHaveBeenCalled();
  });

  it("returns 410 job_gone instead of 404 for a missing job", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "missing" } });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "job_gone" });
  });

  it("returns 409 job_cancelled for a cancelled job", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "job-1", job_type: "CREATE_USER", payload: {}, node_id: "node-1", status: "cancelled" },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "job-1" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_cancelled" });
  });

  it("returns 409 stale_claim when the claim_token does not match", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "job-1",
        job_type: "CREATE_USER",
        payload: {},
        node_id: "node-1",
        status: "claimed",
        claim_token: "correct",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    const res = await onRequestPost({
      env,
      request: makeRequest({ error: "boom", claim_token: "wrong" }),
      params: { id: "job-1" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_claim" });
    expect(jobsUpdate).not.toHaveBeenCalled();
  });

  it("treats an already-done or already-failed job as an idempotent duplicate, not a claim error", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "job-1", job_type: "CREATE_USER", payload: {}, node_id: "node-1", status: "done" },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest({ error: "boom" }), params: { id: "job-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(jobsUpdate).not.toHaveBeenCalled();
  });
});
