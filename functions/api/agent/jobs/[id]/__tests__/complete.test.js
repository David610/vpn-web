import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const jobsUpdate = vi.fn();
const jobsUpdateEq = vi.fn();
const vpnAccountsUpdate = vi.fn();
const vpnAccountsUpdateEq = vi.fn();
const alertUpdate = vi.fn();
const alertEq = vi.fn();

vi.mock("../../../../../lib/node-auth.js", () => ({
  authenticateNode: vi.fn(),
}));

vi.mock("../../../../../lib/crypto.js", () => ({
  encryptSecret: vi.fn(),
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
      if (table === "vpn_accounts") {
        return {
          update: vpnAccountsUpdate.mockReturnValue({ eq: vpnAccountsUpdateEq }),
        };
      }
      if (table === "operational_alerts") {
        const chain = {
          update: alertUpdate.mockReturnValue({
            eq: alertEq.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        };
        return chain;
      }
      return {};
    }),
  })),
}));

const { authenticateNode } = await import("../../../../../lib/node-auth.js");
const { onRequestPost } = await import("../complete.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(result = {}) {
  return new Request("https://example.test/api/agent/jobs/job-1/complete", {
    method: "POST",
    headers: { Authorization: "Bearer key" },
    body: JSON.stringify({ result }),
  });
}

beforeEach(() => {
  maybeSingle.mockReset();
  jobsUpdate.mockClear();
  jobsUpdateEq.mockReset().mockResolvedValue({ error: null });
  vpnAccountsUpdate.mockClear();
  vpnAccountsUpdateEq.mockReset().mockResolvedValue({ error: null });
  alertUpdate.mockClear();
  alertEq.mockClear();
  authenticateNode.mockReset().mockResolvedValue("node-1");
});

describe("agent/jobs/[id]/complete", () => {
  it("sets vpn_accounts.enabled=false after DISABLE_USER completes", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "job-1",
        job_type: "DISABLE_USER",
        payload: {},
        vpn_account_id: 7,
        node_id: "node-1",
        status: "claimed",
      },
      error: null,
    });

    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "job-1" } });
    expect(res.status).toBe(200);
    expect(vpnAccountsUpdate).toHaveBeenCalledWith({ enabled: false });
    expect(vpnAccountsUpdateEq).toHaveBeenCalledWith("id", 7);
    expect(alertUpdate).toHaveBeenCalled();
  });

  it("sets vpn_accounts.enabled=true after ENABLE_USER completes", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: "job-1",
        job_type: "ENABLE_USER",
        payload: {},
        vpn_account_id: 7,
        node_id: "node-1",
        status: "claimed",
      },
      error: null,
    });

    const res = await onRequestPost({ env, request: makeRequest(), params: { id: "job-1" } });
    expect(res.status).toBe(200);
    expect(vpnAccountsUpdate).toHaveBeenCalledWith({ enabled: true });
    expect(alertUpdate).toHaveBeenCalled();
  });
});
