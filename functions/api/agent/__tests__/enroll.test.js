import { describe, it, expect, vi, beforeEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const updateMaybeSingle = vi.fn();
const nodeUpdateChain = {
  eq: vi.fn().mockReturnThis(),
  gt: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  maybeSingle: updateMaybeSingle,
};
const nodeUpdate = vi.fn(() => nodeUpdateChain);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: nodeMaybeSingle,
          update: nodeUpdate,
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPost } = await import("../enroll.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(token) {
  return new Request("https://example.test/api/agent/enroll", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({
    data: { node_id: "de-fra-3", lifecycle_state: "PROVISIONING", enrollment_token_expires_at: FUTURE },
    error: null,
  });
  updateMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "de-fra-3" }, error: null });
  nodeUpdate.mockClear();
  nodeUpdateChain.eq.mockClear();
  nodeUpdateChain.gt.mockClear();
});

describe("POST /api/agent/enroll", () => {
  it("returns 401 with no bearer token", async () => {
    const res = await onRequestPost({ env, request: makeRequest(null) });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token matches no node", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("bogus") });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fra-3", lifecycle_state: "PROVISIONING", enrollment_token_expires_at: PAST },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest("expired-token") });
    expect(res.status).toBe(401);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 when the node isn't in PROVISIONING", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fra-3", lifecycle_state: "READY", enrollment_token_expires_at: FUTURE },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest("token") });
    expect(res.status).toBe(409);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("issues a fresh API key, clears the enrollment token, and moves the node to WARMING_UP", async () => {
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeId).toBe("de-fra-3");
    expect(typeof body.apiKey).toBe("string");
    expect(body.apiKey).not.toBe("good-token");

    const update = nodeUpdate.mock.calls[0][0];
    expect(update.lifecycle_state).toBe("WARMING_UP");
    expect(update.enrollment_token_hash).toBeNull();
    expect(update.enrollment_token_expires_at).toBeNull();
    expect(update.api_key_hash).toMatch(/^[0-9a-f]{64}$/);

    // Guarded on the token hash AND the lifecycle_state this request
    // read, not just node_id (a lost race must not silently re-consume
    // an already-spent token, and must not overwrite a concurrent
    // lifecycle change — see the test below).
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("node_id", "de-fra-3");
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("enrollment_token_hash", expect.any(String));
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("lifecycle_state", "PROVISIONING");
    expect(nodeUpdateChain.gt).toHaveBeenCalledWith("enrollment_token_expires_at", expect.any(String));
  });

  it("returns 409 without a false success when another request wins the enroll race", async () => {
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(409);
  });

  it("does not resurrect a node an admin quarantined between the read and the write", async () => {
    // The SELECT above still sees the pre-quarantine PROVISIONING state
    // (this request raced ahead of the admin's PATCH .../lifecycle), but
    // by the time this UPDATE runs the admin's own optimistic-concurrency
    // guard already flipped lifecycle_state to QUARANTINED — so the
    // lifecycle_state='PROVISIONING' guard here matches zero rows.
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.apiKey).toBeUndefined();
  });
});
