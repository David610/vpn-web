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
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      if (table === "vpn_accounts") {
        return {
          update: vpnAccountsUpdate.mockReturnValue({ eq: vpnAccountsUpdateEq }),
          // finalizeCreatedIdentity's "others on a different node" lookup
          // (identity-lifecycle.js): no stale identities in this scenario.
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === "vpn_secrets") {
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
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
    rpc: vi.fn((fn) => {
      if (fn === "device_entitlement") {
        return Promise.resolve({
          data: [{ entitled: true, subscription_id: "sub-1", reason: null }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
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

  it("never persists the plaintext subscription_url/provisioning_url into provisioning_jobs.result (F-04)", async () => {
    const { encryptSecret } = await import("../../../../../lib/crypto.js");
    encryptSecret.mockResolvedValue({ ciphertext: "cipher", nonce: "nonce" });
    maybeSingle.mockResolvedValue({
      data: {
        id: "job-1",
        job_type: "ROTATE_SUBSCRIPTION_TOKEN",
        payload: {},
        vpn_account_id: 7,
        node_id: "node-1",
        status: "claimed",
      },
      error: null,
    });

    const secretUrl = "https://node.example/sub/very-secret-token";
    const provisioningUrl = "https://node.example/provision/other-secret";
    const res = await onRequestPost({
      env,
      request: makeRequest({ subscription_url: secretUrl, provisioning_url: provisioningUrl }),
      params: { id: "job-1" },
    });
    expect(res.status).toBe(200);

    const storedResult = jobsUpdate.mock.calls[0][0].result;
    const serialized = JSON.stringify(storedResult);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain(provisioningUrl);
    expect(storedResult.subscription_url_reported).toBe(true);
    expect(storedResult.provisioning_url_reported).toBe(true);
    expect(storedResult.subscription_url).toBeUndefined();
    expect(storedResult.provisioning_url).toBeUndefined();
  });

  // F-09/D-03/C-10: claim-token/lease validation.
  describe("claim-token validation (F-09/C-10)", () => {
    it("returns 410 job_gone instead of 404 when the job does not exist", async () => {
      maybeSingle.mockResolvedValue({ data: null, error: null });
      const res = await onRequestPost({ env, request: makeRequest(), params: { id: "missing" } });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "job_gone" });
    });

    it("returns 409 job_cancelled for a cancelled job", async () => {
      maybeSingle.mockResolvedValue({
        data: { id: "job-1", job_type: "DISABLE_USER", payload: {}, vpn_account_id: 7, node_id: "node-1", status: "cancelled" },
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
          job_type: "DISABLE_USER",
          payload: {},
          vpn_account_id: 7,
          node_id: "node-1",
          status: "claimed",
          claim_token: "correct-token",
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      const request = new Request("https://example.test/api/agent/jobs/job-1/complete", {
        method: "POST",
        headers: { Authorization: "Bearer key" },
        body: JSON.stringify({ result: {}, claim_token: "wrong-token" }),
      });
      const res = await onRequestPost({ env, request, params: { id: "job-1" } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_claim" });
      expect(vpnAccountsUpdate).not.toHaveBeenCalled();
    });

    it("returns 409 stale_claim once the lease has expired, even with the right token", async () => {
      maybeSingle.mockResolvedValue({
        data: {
          id: "job-1",
          job_type: "DISABLE_USER",
          payload: {},
          vpn_account_id: 7,
          node_id: "node-1",
          status: "claimed",
          claim_token: "the-token",
          lease_expires_at: new Date(Date.now() - 1000).toISOString(),
        },
        error: null,
      });
      const request = new Request("https://example.test/api/agent/jobs/job-1/complete", {
        method: "POST",
        headers: { Authorization: "Bearer key" },
        body: JSON.stringify({ result: {}, claim_token: "the-token" }),
      });
      const res = await onRequestPost({ env, request, params: { id: "job-1" } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_claim" });
    });

    it("accepts a matching, current claim_token", async () => {
      maybeSingle.mockResolvedValue({
        data: {
          id: "job-1",
          job_type: "DISABLE_USER",
          payload: {},
          vpn_account_id: 7,
          node_id: "node-1",
          status: "claimed",
          claim_token: "the-token",
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      const request = new Request("https://example.test/api/agent/jobs/job-1/complete", {
        method: "POST",
        headers: { Authorization: "Bearer key" },
        body: JSON.stringify({ result: {}, claim_token: "the-token" }),
      });
      const res = await onRequestPost({ env, request, params: { id: "job-1" } });
      expect(res.status).toBe(200);
      expect(vpnAccountsUpdate).toHaveBeenCalledWith({ enabled: false });
    });

    it("rejects a tokenless report once REQUIRE_CLAIM_TOKEN is flipped on", async () => {
      maybeSingle.mockResolvedValue({
        data: {
          id: "job-1",
          job_type: "DISABLE_USER",
          payload: {},
          vpn_account_id: 7,
          node_id: "node-1",
          status: "claimed",
          claim_token: "the-token",
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });
      const res = await onRequestPost({
        env: { ...env, REQUIRE_CLAIM_TOKEN: "true" },
        request: makeRequest(),
        params: { id: "job-1" },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_claim" });
    });
  });
});
