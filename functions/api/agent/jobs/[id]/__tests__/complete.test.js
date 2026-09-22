import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const jobsUpdate = vi.fn();
const jobsUpdateEq = vi.fn();
const vpnAccountsUpdate = vi.fn();
const vpnAccountsUpdateEq = vi.fn();

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
  authenticateNode.mockReset().mockResolvedValue("node-1");
});

describe("agent/jobs/[id]/complete vpn_accounts.enabled", () => {
  it("sets vpn_accounts.enabled = false on a DISABLE_USER completion", async () => {
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
  });

  it("sets vpn_accounts.enabled = true on an ENABLE_USER completion", async () => {
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
    expect(vpnAccountsUpdateEq).toHaveBeenCalledWith("id", 7);
  });
});
