import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateNode = vi.fn(async () => "node-1");
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("../../../lib/node-auth.js", () => ({ authenticateNode: (...a) => authenticateNode(...a) }));

const { onRequestGet } = await import("../events.js");

const wait = vi.fn();
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k", AGENT_EVENT_HUB: { wait } };
const get = (qs = "", e = env) => onRequestGet({ env: e, request: new Request(`https://api.test/api/agent/events${qs}`) });

beforeEach(() => {
  wait.mockReset().mockResolvedValue({ reason: "timeout", changed: [], cursor: "c1" });
  authenticateNode.mockReset().mockResolvedValue("node-1");
});

describe("GET /api/agent/events", () => {
  it("requires node authentication", async () => {
    authenticateNode.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reports 501 with a polling fallback hint where no hub exists (Cloudflare Pages)", async () => {
    const res = await get("", { ...env, AGENT_EVENT_HUB: undefined });
    expect(res.status).toBe(501);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await res.json()).toMatchObject({ fallback: "poll" });
  });

  it("passes the node, cursor and a clamped timeout to the hub", async () => {
    await get("?cursor=abc&wait=999");
    expect(wait).toHaveBeenCalledWith("node-1", "abc", expect.objectContaining({ timeoutMs: 30_000 }));
    await get("?wait=0");
    expect(wait).toHaveBeenLastCalledWith("node-1", undefined, expect.objectContaining({ timeoutMs: 0 }));
    await get();
    expect(wait).toHaveBeenLastCalledWith("node-1", undefined, expect.objectContaining({ timeoutMs: 25_000 }));
  });

  it("rejects a non-numeric wait", async () => {
    expect((await get("?wait=abc")).status).toBe(400);
  });

  it("returns the hub result, uncacheable", async () => {
    wait.mockResolvedValueOnce({ reason: "change", changed: ["jobs"], cursor: "c2" });
    const res = await get("?cursor=c1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ reason: "change", changed: ["jobs"], cursor: "c2" });
  });

  it("answers 409 + Retry-After when superseded so two agents cannot hot-loop", async () => {
    wait.mockResolvedValueOnce({ reason: "superseded", changed: [], cursor: "c1" });
    const res = await get("?cursor=c1");
    expect(res.status).toBe(409);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(5);
  });

  it("answers 503 + Retry-After when the database is unavailable", async () => {
    wait.mockRejectedValueOnce(new Error("db down"));
    const res = await get("?cursor=c1");
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });

  it("answers 501 + poll fallback (not 503) when the database lacks the wake-token functions", async () => {
    wait.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "EVENT_CHANNEL_UNSUPPORTED" }));
    const res = await get("?cursor=c1");
    expect(res.status).toBe(501);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(60);
    expect(await res.json()).toMatchObject({ fallback: "poll" });
  });

  it("hands the request abort signal to the hub so a closed connection frees the slot", async () => {
    await get();
    expect(wait.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });
});
