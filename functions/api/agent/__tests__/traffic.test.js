import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: nodeMaybeSingle,
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
  })),
}));

const { onRequestPost } = await import("../traffic.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body, { auth = "Bearer node-key" } = {}) {
  return new Request("https://example.test/api/agent/traffic", {
    method: "POST",
    headers: auth
      ? { Authorization: auth, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validSample = () => ({
  bytes_up: 1_000_000,
  bytes_down: 5_000_000,
  connections_open: 4,
  sampled_at: new Date().toISOString(),
});

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({
    data: { node_id: "node-1", revoked_at: null },
    error: null,
  });
  rpc.mockReset().mockResolvedValue({
    data: [{ delta_up: 1000, delta_down: 5000, interval_seconds: 15, counter_reset: false }],
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/agent/traffic", () => {
  it("records a sample and returns the derived delta", async () => {
    const res = await onRequestPost({ env, request: makeRequest(validSample()) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      delta_up: 1000,
      delta_down: 5000,
      interval_seconds: 15,
      counter_reset: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_node_traffic",
      expect.objectContaining({ p_node_id: "node-1", p_bytes_up: 1_000_000 })
    );
  });

  it("attributes the sample to the authenticated node, not to anything in the body", async () => {
    // A node must not be able to write traffic against someone else's id.
    await onRequestPost({
      env,
      request: makeRequest({ ...validSample(), node_id: "node-victim" }),
    });
    expect(rpc.mock.calls[0][1].p_node_id).toBe("node-1");
  });

  it("rejects an unauthenticated request without touching the database", async () => {
    const res = await onRequestPost({ env, request: makeRequest(validSample(), { auth: null }) });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a revoked node key", async () => {
    nodeMaybeSingle.mockResolvedValue({
      data: { node_id: "node-1", revoked_at: "2026-01-01T00:00:00Z" },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest(validSample()) });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative counter", { bytes_up: -1 }],
    ["a fractional counter", { bytes_down: 1.5 }],
    ["a string counter", { bytes_up: "100" }],
    ["a missing counter", { connections_open: undefined }],
    ["a counter past 2^53", { bytes_up: Number.MAX_SAFE_INTEGER + 2 }],
  ])("rejects %s", async (_label, override) => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ ...validSample(), ...override }),
    });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed timestamp", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ ...validSample(), sampled_at: "not-a-date" }),
    });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a sample timestamped far in the future", async () => {
    // A clock-skewed node writing ahead of real time would become the
    // baseline every later report differences against, stalling the series.
    const res = await onRequestPost({
      env,
      request: makeRequest({
        ...validSample(),
        sampled_at: new Date(Date.now() + 86400_000).toISOString(),
      }),
    });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a slightly skewed clock rather than being brittle", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({
        ...validSample(),
        sampled_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a malformed body", async () => {
    const res = await onRequestPost({ env, request: makeRequest("{not json") });
    expect(res.status).toBe(400);
  });

  it("surfaces a counter reset to the caller", async () => {
    rpc.mockResolvedValue({
      data: [{ delta_up: 500, delta_down: 900, interval_seconds: 15, counter_reset: true }],
      error: null,
    });
    const body = await (await onRequestPost({ env, request: makeRequest(validSample()) })).json();
    expect(body.counter_reset).toBe(true);
  });

  it("500s when the rpc fails, so the agent retries rather than losing the sample", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock" } });
    const res = await onRequestPost({ env, request: makeRequest(validSample()) });
    expect(res.status).toBe(500);
  });
});
