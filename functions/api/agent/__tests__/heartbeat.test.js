import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const nodesUpdate = vi.fn();
const alertsInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: nodeMaybeSingle,
          update: nodesUpdate,
        };
      }
      if (table === "operational_alerts") {
        return {
          insert: alertsInsert,
          update: vi.fn(() => ({ eq: vi.fn().mockReturnThis() })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

// Chainable + awaitable, like a real PostgREST builder: records every
// filter applied so tests can assert on guards.
const updateChains = [];
function updateChain() {
  const chain = { filters: [] };
  for (const op of ["eq", "neq", "not"]) {
    chain[op] = vi.fn((...args) => {
      chain.filters.push([op, ...args]);
      return chain;
    });
  }
  chain.then = (resolve) => resolve({ error: null });
  updateChains.push(chain);
  return chain;
}

const { onRequestPost } = await import("../heartbeat.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/agent/heartbeat", {
    method: "POST",
    headers: { Authorization: "Bearer node-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1", revoked_at: null }, error: null });
  nodesUpdate.mockReset().mockImplementation(() => updateChain());
  alertsInsert.mockReset().mockResolvedValue({ error: null });
  updateChains.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/agent/heartbeat observed_revision", () => {
  it("includes observed_revision in the update when provided", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: 3 }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ observed_revision: 3 });
  });

  it("omits observed_revision entirely rather than coercing to 0 when absent", async () => {
    // An agent build that doesn't report this yet must never look like it
    // just rolled back to revision zero.
    await onRequestPost({ env, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");
  });

  it("omits observed_revision when it is negative or non-integer", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: -1 }) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");

    nodesUpdate.mockClear();
    await onRequestPost({ env, request: makeRequest({ observed_revision: 1.5 }) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");
  });

  it("accepts observed_revision of 0 (a node's initial state)", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: 0 }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ observed_revision: 0 });
  });
});

describe("POST /api/agent/heartbeat enrollment token cleanup", () => {
  it("clears a leftover enrollment token, but never while the node is PROVISIONING", async () => {
    await onRequestPost({ env, request: makeRequest({}) });
    const clearCall = nodesUpdate.mock.calls.findIndex(
      ([patch]) => "enrollment_token_hash" in patch
    );
    expect(clearCall).toBeGreaterThan(0);
    expect(nodesUpdate.mock.calls[clearCall][0]).toEqual({
      enrollment_token_hash: null,
      enrollment_token_expires_at: null,
    });
    // A fresh re-enrollment token (lifecycle.js -> PROVISIONING) must
    // survive an old agent's heartbeat.
    expect(updateChains[clearCall].filters).toContainEqual(["neq", "lifecycle_state", "PROVISIONING"]);
  });

  it("never clears the token as part of the telemetry update itself", async () => {
    await onRequestPost({ env, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("enrollment_token_hash");
  });
});
