import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ rpc })) }));
const advanceOperation = vi.fn();
vi.mock("../../../lib/fleet-operations.js", () => ({ advanceOperation }));

const { onRequestPost } = await import("../fleet-tick.js");
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k", FLEET_TICK_SECRET: "s3cret" };

function req(secret) {
  return new Request("https://x.test/api/internal/fleet-tick", {
    method: "POST",
    headers: secret ? { "X-Fleet-Tick-Secret": secret } : {},
  });
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [{ id: "op-1", type: "CREATE_NODE", node_id: "n1" }], error: null });
  advanceOperation.mockReset().mockResolvedValue({ status: "RUNNING", step: "AWAIT_ENROLLMENT" });
});

describe("POST /api/internal/fleet-tick", () => {
  it.each([[null], ["wrong"], ["S3CRET"], ["s3cret-and-more"]])("rejects a missing/wrong secret (%s) before touching the DB", async (secret) => {
    const res = await onRequestPost({ env, request: req(secret) });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when no secret is configured at all", async () => {
    const res = await onRequestPost({ env: { ...env, FLEET_TICK_SECRET: undefined }, request: req("") });
    expect(res.status).toBe(401);
  });

  it("leases due operations and advances each", async () => {
    const res = await onRequestPost({ env, request: req("s3cret") });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("lease_fleet_operations", { p_limit: 10, p_lease_seconds: 120 });
    expect(await res.json()).toMatchObject({ leased: 1, results: [{ id: "op-1", status: "RUNNING" }] });
  });

  it("keeps going when one operation throws (its lease lapses and the next tick retries)", async () => {
    rpc.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }], error: null });
    advanceOperation.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ status: "COMPLETED" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await onRequestPost({ env, request: req("s3cret") })).json();
    expect(body.results.map((r) => r.status)).toEqual(["ERROR", "COMPLETED"]);
  });
});
