import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn();
const eqNodeId = vi.fn();
const rpc = vi.fn();

// The real postgrest-js query builder is PromiseLike (implements only
// `.then()`), not a real Promise — it does NOT have `.catch()`. This mock
// intentionally returns a plain `{ then }` thenable (no `.catch`) instead of
// a real Promise, so it reproduces the actual builder's shape and would
// throw a TypeError against code that calls `.catch()` on it, the way a
// real Promise's `.catch` would silently succeed and mask the bug.
function makeThenable(result) {
  return {
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
}

vi.mock("../../../lib/node-auth.js", () => ({
  authenticateNode: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({ update: update.mockReturnValue({ eq: eqNodeId }) })),
    rpc,
  })),
}));

const { authenticateNode } = await import("../../../lib/node-auth.js");
const { onRequestPost } = await import("../claim.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

beforeEach(() => {
  update.mockClear();
  eqNodeId.mockReset().mockReturnValue(makeThenable({ error: null }));
  rpc.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("agent/claim last_seen_at", () => {
  it("updates nodes.last_seen_at after a successful authentication", async () => {
    authenticateNode.mockResolvedValue("node-1");
    const request = new Request("https://example.test/api/agent/claim", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
    });
    await onRequestPost({ env, request });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_at: expect.any(String) }));
    expect(eqNodeId).toHaveBeenCalledWith("node_id", "node-1");
  });

  it("does not touch nodes when authentication fails", async () => {
    authenticateNode.mockResolvedValue(null);
    const request = new Request("https://example.test/api/agent/claim", { method: "POST" });
    await onRequestPost({ env, request });
    expect(update).not.toHaveBeenCalled();
  });

  it("logs but does not throw when the last_seen_at update fails", async () => {
    authenticateNode.mockResolvedValue("node-1");
    eqNodeId.mockReturnValue(makeThenable({ error: { message: "boom" } }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://example.test/api/agent/claim", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
    });
    const response = await onRequestPost({ env, request });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith("claim: last_seen_at update failed:", "boom");
    });
    consoleErrorSpy.mockRestore();
  });

  it("would have caught the old .catch()-on-thenable bug: calling .catch on the mock throws", () => {
    // Documents WHY this mock shape matters: the real postgrest-js builder
    // (and this thenable mock) has no `.catch`, only `.then`. The old
    // claim.js called `.catch(...)` directly on the query chain, which
    // would throw synchronously here, exactly as it does against the real
    // client in production.
    const thenable = eqNodeId();
    expect(thenable.catch).toBeUndefined();
    expect(() => thenable.catch(() => {})).toThrow(TypeError);
  });
});
