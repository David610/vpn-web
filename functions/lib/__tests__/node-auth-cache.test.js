import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateNode, configureNodeAuthCache, invalidateNodeAuth } from "../node-auth.js";

function makeSupabase(rows) {
  const maybeSingle = vi.fn(async () => ({ data: rows.current, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { client: { from: vi.fn(() => ({ select })) }, maybeSingle };
}
const req = (key) => new Request("https://x.test/api/agent/claim", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
const live = { node_id: "de1", revoked_at: null, lifecycle_state: "READY" };

afterEach(() => configureNodeAuthCache(null));

describe("node auth cache", () => {
  it("is disabled by default: every request hits the database (Pages behaviour unchanged)", async () => {
    const { client, maybeSingle } = makeSupabase({ current: live });
    await authenticateNode(req("k"), client);
    await authenticateNode(req("k"), client);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("serves repeat requests from memory inside the TTL, then re-checks", async () => {
    let t = 1_000;
    configureNodeAuthCache({ ttlMs: 5_000, negativeTtlMs: 1_000, now: () => t });
    const { client, maybeSingle } = makeSupabase({ current: live });
    for (let i = 0; i < 50; i += 1) expect(await authenticateNode(req("k"), client)).toBe("de1");
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    t += 5_001;
    await authenticateNode(req("k"), client);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("stops accepting a revoked node no later than the TTL", async () => {
    let t = 0;
    configureNodeAuthCache({ ttlMs: 5_000, now: () => t });
    const rows = { current: live };
    const { client } = makeSupabase(rows);
    expect(await authenticateNode(req("k"), client)).toBe("de1");
    rows.current = { ...live, revoked_at: "2026-10-16T00:00:00Z" };
    t += 5_001;
    expect(await authenticateNode(req("k"), client)).toBeNull();
  });

  it("invalidateNodeAuth drops a node immediately", async () => {
    configureNodeAuthCache({ ttlMs: 60_000, now: () => 0 });
    const rows = { current: live };
    const { client } = makeSupabase(rows);
    await authenticateNode(req("k"), client);
    rows.current = null;
    invalidateNodeAuth("de1");
    expect(await authenticateNode(req("k"), client)).toBeNull();
  });

  it("briefly remembers rejected keys so a bad-key storm does not reach the database", async () => {
    let t = 0;
    configureNodeAuthCache({ ttlMs: 5_000, negativeTtlMs: 2_000, now: () => t });
    const { client, maybeSingle } = makeSupabase({ current: null });
    for (let i = 0; i < 20; i += 1) expect(await authenticateNode(req("bad"), client)).toBeNull();
    expect(maybeSingle).toHaveBeenCalledTimes(1);
    t += 2_001;
    await authenticateNode(req("bad"), client);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("never caches a lookup error", async () => {
    configureNodeAuthCache({ ttlMs: 5_000, now: () => 0 });
    const maybeSingle = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
    const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) };
    await expect(authenticateNode(req("k"), client)).rejects.toThrow();
    await expect(authenticateNode(req("k"), client)).rejects.toThrow();
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("bounds memory", async () => {
    configureNodeAuthCache({ ttlMs: 60_000, maxEntries: 8, now: () => 0 });
    const { client, maybeSingle } = makeSupabase({ current: live });
    for (let i = 0; i < 40; i += 1) await authenticateNode(req(`k${i}`), client);
    await authenticateNode(req("k0"), client); // evicted, must be looked up again
    expect(maybeSingle).toHaveBeenCalledTimes(41);
  });
});
