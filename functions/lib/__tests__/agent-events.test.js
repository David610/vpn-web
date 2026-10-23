import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../agent-events.js";

const tokens = { n1: { jobs: "0:0", auth: 1, lease: "a", ent: "e1" } };
const fetchWake = vi.fn();
const fetchEnt = vi.fn();

function hub(overrides = {}) {
  return createEventHub({
    fetchWakeTokens: fetchWake,
    fetchEntitlementTokens: fetchEnt,
    intervalMs: 1000,
    entitlementIntervalMs: 5000,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(tokens)) delete tokens[k];
  tokens.n1 = { jobs: "0:0", auth: 1, lease: "a", ent: "e1" };
  fetchWake.mockReset().mockImplementation(async (ids) =>
    new Map(ids.map((id) => [id, { jobs: tokens[id]?.jobs ?? "0:0", auth: tokens[id]?.auth ?? 0, lease: tokens[id]?.lease ?? "" }])));
  fetchEnt.mockReset().mockImplementation(async (ids) => new Map(ids.map((id) => [id, tokens[id]?.ent ?? ""])));
});
afterEach(() => vi.useRealTimers());

const settle = async (ms) => { await vi.advanceTimersByTimeAsync(ms); };

describe("agent event hub", () => {
  it("answers a cursor-less wait immediately with a full resync and a cursor", async () => {
    const h = hub();
    const r = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    expect(r.reason).toBe("resync");
    expect(r.changed.sort()).toEqual(["authorizations", "jobs", "leases"]);
    expect(typeof r.cursor).toBe("string");
  });

  it("blocks on a current cursor and wakes within one interval when a job appears", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const pending = h.wait("n1", cursor, { timeoutMs: 25_000 });
    let done = false; pending.then(() => { done = true; });
    await settle(900);
    expect(done).toBe(false);
    tokens.n1.jobs = "7:1";
    await settle(1100);
    const r = await pending;
    expect(r).toMatchObject({ reason: "change", changed: ["jobs"] });
    expect(r.cursor).not.toBe(cursor);
  });

  it("reports lease and authorization changes on their own channels", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const p = h.wait("n1", cursor, { timeoutMs: 25_000 });
    tokens.n1.lease = "revoked-urgent"; tokens.n1.auth = 2;
    await settle(1100);
    expect((await p).changed.sort()).toEqual(["authorizations", "leases"]);
  });

  it("treats an entitlement flip as an authorizations change, on the slower cadence", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const p = h.wait("n1", cursor, { timeoutMs: 25_000 });
    tokens.n1.ent = "e2";
    await settle(5100);
    expect(await p).toMatchObject({ reason: "change", changed: ["authorizations"] });
  });

  it("uses O(1) database calls per tick regardless of how many agents wait", async () => {
    const h = hub();
    const ids = Array.from({ length: 200 }, (_, i) => `node-${i}`);
    const cursors = {};
    for (const id of ids) cursors[id] = (await h.wait(id, undefined, { timeoutMs: 25_000 })).cursor;
    fetchWake.mockClear(); fetchEnt.mockClear();
    const waits = ids.map((id) => h.wait(id, cursors[id], { timeoutMs: 4_500 }));
    await settle(4_600);
    await Promise.all(waits);
    expect(fetchWake.mock.calls.length).toBeLessThanOrEqual(5);
    for (const [batch] of fetchWake.mock.calls) expect(batch.length).toBeLessThanOrEqual(200);
    expect(fetchEnt.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("does no database work while nobody is waiting", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    fetchWake.mockClear();
    await settle(30_000);
    expect(fetchWake).not.toHaveBeenCalled();
    expect(h.waiterCount()).toBe(0);
    void cursor;
  });

  it("returns a timeout with an unchanged cursor", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const p = h.wait("n1", cursor, { timeoutMs: 3_000 });
    await settle(3_100);
    expect(await p).toEqual({ reason: "timeout", changed: [], cursor });
    expect(h.waiterCount()).toBe(0);
  });

  it("lets a newer connection from the same node supersede the older one", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const old = h.wait("n1", cursor, { timeoutMs: 25_000 });
    const fresh = h.wait("n1", cursor, { timeoutMs: 2_000 });
    expect(await old).toMatchObject({ reason: "superseded", changed: [] });
    await settle(2_100);
    expect((await fresh).reason).toBe("timeout");
  });

  it("drops a waiter whose client disconnected", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const ctl = new AbortController();
    const p = h.wait("n1", cursor, { timeoutMs: 25_000, signal: ctl.signal });
    expect(h.waiterCount()).toBe(1);
    ctl.abort();
    expect(await p).toMatchObject({ reason: "aborted" });
    expect(h.waiterCount()).toBe(0);
  });

  it("survives database errors with backoff and recovers without losing the waiter", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    fetchWake.mockRejectedValue(new Error("db down"));
    const p = h.wait("n1", cursor, { timeoutMs: 25_000 });
    await settle(10_000);
    const failedCalls = fetchWake.mock.calls.length;
    expect(failedCalls).toBeLessThan(10); // backed off, no hot loop
    fetchWake.mockImplementation(async (ids) => new Map(ids.map((id) => [id, { jobs: "9:1", auth: 1, lease: "a" }])));
    await settle(20_000);
    expect(await p).toMatchObject({ reason: "change", changed: ["jobs"] });
  });

  it("treats a malformed or foreign cursor as a resync request", async () => {
    const h = hub();
    expect((await h.wait("n1", "not-a-cursor", { timeoutMs: 25_000 })).reason).toBe("resync");
  });

  it("a pre-change cursor is not answered from a stale cache when no waiter was active (revocation latency)", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    await settle(7000); // idle: no waiter, so the watcher never refreshes
    tokens.n1.auth = 2; tokens.n1.ent = "e2"; // revoked / lapsed in the database
    await settle(7000);
    const r = await h.wait("n1", cursor, { timeoutMs: 25_000 });
    expect(r.reason).toBe("change");
    expect(r.changed).toEqual(["authorizations"]);
  });

  it("does not re-read the database on every call: a fresh cache is reused", async () => {
    const h = hub();
    const { cursor } = await h.wait("n1", undefined, { timeoutMs: 25_000 });
    const before = fetchWake.mock.calls.length;
    const p = h.wait("n1", cursor, { timeoutMs: 100 });
    await settle(200);
    await p;
    expect(fetchWake.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});
