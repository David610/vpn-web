import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn();
const eqNodeId = vi.fn();
const rpc = vi.fn();

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
  eqNodeId.mockReset().mockResolvedValue({ error: null });
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
});
