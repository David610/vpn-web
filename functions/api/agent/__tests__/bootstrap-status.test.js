import { describe, it, expect, vi, beforeEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const updateEq = vi.fn();
const nodesUpdate = vi.fn(() => ({ eq: updateEq }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: nodeMaybeSingle,
      update: nodesUpdate,
    })),
  })),
}));

const { onRequestPost } = await import("../bootstrap-status.js");
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k" };
const req = (body, auth = "Bearer node-key") =>
  new Request("https://x.test/api/agent/bootstrap-status", {
    method: "POST",
    headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "n1", revoked_at: null }, error: null });
  updateEq.mockReset().mockResolvedValue({ error: null });
  nodesUpdate.mockClear();
});

describe("POST /api/agent/bootstrap-status", () => {
  it("requires the node's own API key", async () => {
    const res = await onRequestPost({ env, request: req({ stage: "INSTALL", status: "OK" }, null) });
    expect(res.status).toBe(401);
  });

  it("rejects unknown stages/statuses", async () => {
    for (const body of [{ stage: "PWN", status: "OK" }, { stage: "INSTALL", status: "DONE" }]) {
      expect((await onRequestPost({ env, request: req(body) })).status).toBe(400);
    }
    expect(nodesUpdate).not.toHaveBeenCalled();
  });

  it("records the stage for the authenticated node only, with a sanitized message", async () => {
    const res = await onRequestPost({
      env,
      request: req({ stage: "INSTALL", status: "FAILED", message: "exit 1 <script>alert(1)</script>" }),
    });
    expect(res.status).toBe(200);
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({
      bootstrap_stage: "INSTALL",
      bootstrap_status: "FAILED",
      bootstrap_message: "exit 1 scriptalert(1)/script",
    });
    expect(updateEq).toHaveBeenCalledWith("node_id", "n1");
  });
});
