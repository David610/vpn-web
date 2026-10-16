import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
const rpc = vi.fn();
vi.mock("../../../lib/node-auth.js", () => ({ authenticateNode: vi.fn(async () => "node-1") }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({ update: update.mockReturnValue({ eq: () => ({ then: (ok) => Promise.resolve({ error: null }).then(ok) }) }) })),
    rpc,
  })),
}));

const { onRequestPost } = await import("../claim.js");
const { configureNodeTouchThrottle } = await import("../../../lib/node-touch.js");
const env = { SUPABASE_URL: "https://s.test", SUPABASE_SERVICE_ROLE_KEY: "k" };
const claim = () => onRequestPost({ env, request: new Request("https://x.test/api/agent/claim", { method: "POST" }) });

beforeEach(() => {
  update.mockClear();
  rpc.mockReset().mockResolvedValue({ data: [], error: null });
  configureNodeTouchThrottle(null);
});

describe("claim last_seen_at write", () => {
  it("writes every time when no throttle is configured (Pages behaviour unchanged)", async () => {
    for (let i = 0; i < 4; i += 1) await claim();
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("writes at most once per interval per node when throttled, yet always claims", async () => {
    let t = 1_000;
    configureNodeTouchThrottle(30_000, () => t);
    for (let i = 0; i < 10; i += 1) await claim();
    expect(update).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(10);
    t += 30_001;
    await claim();
    expect(update).toHaveBeenCalledTimes(2);
  });
});
