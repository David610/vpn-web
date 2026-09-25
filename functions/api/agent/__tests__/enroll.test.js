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

const KEY_HASH = "a".repeat(64);
const OTHER_KEY_HASH = "b".repeat(64);

function makeRequest(token, body = { nodeId: "de-fra-3", apiKeySha256: KEY_HASH }) {
  return new Request("https://example.test/api/agent/enroll", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({
    data: {
      node_id: "de-fra-3",
      lifecycle_state: "PROVISIONING",
      enrollment_token_expires_at: FUTURE,
      api_key_hash: null,
    },
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

  it("returns 400 unless the body carries a lowercase hex SHA-256 of the node's key", async () => {
    for (const body of [{}, { apiKeySha256: "short" }, { apiKeySha256: "A".repeat(64) }]) {
      const res = await onRequestPost({ env, request: makeRequest("token", body) });
      expect(res.status).toBe(400);
    }
    expect(nodeMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns 401 when the token matches no node", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("bogus") });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token belongs to a different node than the one claimed", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest("token", { nodeId: "fi-hel-9", apiKeySha256: KEY_HASH }),
    });
    expect(res.status).toBe(401);
    expect(nodeUpdate).not.toHaveBeenCalled();
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

  it("returns 409 when the node isn't awaiting enrollment", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fra-3", lifecycle_state: "READY", enrollment_token_expires_at: FUTURE, api_key_hash: null },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest("token") });
    expect(res.status).toBe(409);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("binds the node-generated key hash and moves the node to WARMING_UP without ever returning a key", async () => {
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ nodeId: "de-fra-3", alreadyEnrolled: false });

    const update = nodeUpdate.mock.calls[0][0];
    expect(update).toMatchObject({ api_key_hash: KEY_HASH, lifecycle_state: "WARMING_UP" });
    expect(new Date(update.lifecycle_state_changed_at).getTime()).toBeGreaterThan(Date.now() - 5000);
    // The token hash is deliberately NOT cleared here: an idempotent retry
    // after a lost response must still find the row (see next tests).
    expect(update).not.toHaveProperty("enrollment_token_hash");

    // Guarded on the token hash AND the lifecycle_state this request
    // read, not just node_id (a lost race must not bind a second key, and
    // must not overwrite a concurrent lifecycle change -- see below).
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("node_id", "de-fra-3");
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("enrollment_token_hash", expect.any(String));
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("lifecycle_state", "PROVISIONING");
    expect(nodeUpdateChain.gt).toHaveBeenCalledWith("enrollment_token_expires_at", expect.any(String));
  });

  it("is idempotent: a retry with the SAME key hash after a lost response succeeds without writing", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fra-3", lifecycle_state: "WARMING_UP", enrollment_token_expires_at: FUTURE, api_key_hash: KEY_HASH },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId: "de-fra-3", alreadyEnrolled: true });
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("refuses to bind a DIFFERENT key with an already-redeemed token (one token, one key)", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fra-3", lifecycle_state: "WARMING_UP", enrollment_token_expires_at: FUTURE, api_key_hash: KEY_HASH },
      error: null,
    });
    const res = await onRequestPost({
      env,
      request: makeRequest("good-token", { nodeId: "de-fra-3", apiKeySha256: OTHER_KEY_HASH }),
    });
    expect(res.status).toBe(409);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 without a false success when another request wins the enroll race", async () => {
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(409);
  });

  it("rejects a key hash already bound to another node without saying which", async () => {
    updateMaybeSingle.mockResolvedValue({ data: null, error: { code: "23505", message: "dup" } });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Key rejected" });
  });

  it("does not resurrect a node an admin quarantined between the read and the write", async () => {
    // The SELECT still sees PROVISIONING (this request raced ahead of the
    // admin's PATCH .../lifecycle), but by the time this UPDATE runs the
    // admin already flipped lifecycle_state to QUARANTINED -- so the
    // lifecycle_state='PROVISIONING' guard matches zero rows.
    updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({ env, request: makeRequest("good-token") });
    expect(res.status).toBe(409);
  });
});
