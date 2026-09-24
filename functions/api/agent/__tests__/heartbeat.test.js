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
  nodesUpdate.mockReset().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  alertsInsert.mockReset().mockResolvedValue({ error: null });
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

    nodesUpdate.mockClear().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    await onRequestPost({ env, request: makeRequest({ observed_revision: 1.5 }) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");
  });

  it("accepts observed_revision of 0 (a node's initial state)", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: 0 }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ observed_revision: 0 });
  });
});
