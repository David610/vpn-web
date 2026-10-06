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
// A real sing-box REALITY public key: base64url, 43 characters, contains "-" and "_".
const REAL_KEY = "Vq8-_0123456789abcdefghijklmnopqrstuvwx_-Zz";
const REAL_SID = "a1b2c3d4";
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

  it("persists a well-formed vless-reality transport report alongside COMPLETE", async () => {
    const res = await onRequestPost({
      env,
      request: req({
        stage: "COMPLETE",
        status: "OK",
        message: "bootstrap complete",
        transport: {
          transport: "vless-reality",
          server_port: 443,
          tls_server_name: "decoy.example.test",
          reality_public_key: REAL_KEY,
          reality_short_id: REAL_SID,
          reality_fingerprint: "chrome",
          vless_flow: "xtls-rprx-vision",
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({
      transport: "vless-reality",
      transport_port: 443,
      tls_server_name: "decoy.example.test",
      reality_public_key: REAL_KEY,
      reality_short_id: REAL_SID,
      reality_fingerprint: "chrome",
      vless_flow: "xtls-rprx-vision",
    });
  });

  const transportWith = (overrides) => ({
    stage: "COMPLETE",
    status: "OK",
    message: "bootstrap complete",
    transport: {
      transport: "vless-reality",
      server_port: 443,
      tls_server_name: "decoy.example.test",
      reality_public_key: REAL_KEY,
      reality_short_id: REAL_SID,
      reality_fingerprint: "chrome",
      vless_flow: "xtls-rprx-vision",
      ...overrides,
    },
  });

  it("never publishes a REALITY public key that is not 43 base64url characters", async () => {
    for (const bad of [REAL_KEY.slice(0, 41), REAL_KEY + "A", "abc123", REAL_KEY.replace("-", "+"), REAL_KEY.replace("_", "/")]) {
      nodesUpdate.mockClear();
      const res = await onRequestPost({ env, request: req(transportWith({ reality_public_key: bad })) });
      expect(res.status).toBe(200); // the stage report itself is still accepted
      expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("reality_public_key");
      expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ bootstrap_stage: "COMPLETE" });
    }
  });

  it("never publishes a REALITY short id that is not even-length hex", async () => {
    for (const bad of ["xyz", "abc", "a1b2c3d4e5f6a7b8c9", "a1b2c3d4 "]) {
      nodesUpdate.mockClear();
      await onRequestPost({ env, request: req(transportWith({ reality_short_id: bad })) });
      expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("reality_short_id");
    }
  });

  it("drops a malformed transport report without failing the rest of the bootstrap-status update", async () => {
    const res = await onRequestPost({
      env,
      request: req({
        stage: "COMPLETE",
        status: "OK",
        message: "bootstrap complete",
        transport: { transport: "carrier-pigeon", server_port: 443 },
      }),
    });
    expect(res.status).toBe(200);
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("transport");
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ bootstrap_stage: "COMPLETE", bootstrap_status: "OK" });
  });

  it("does nothing extra when transport is omitted entirely (today's real agents)", async () => {
    const res = await onRequestPost({
      env,
      request: req({ stage: "COMPLETE", status: "OK", message: "bootstrap complete" }),
    });
    expect(res.status).toBe(200);
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("transport");
  });
});
