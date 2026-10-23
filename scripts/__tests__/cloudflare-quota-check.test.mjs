import { describe, expect, it, vi } from "vitest";
import { evaluate, fetchUsage } from "../cloudflare-quota-check.mjs";

const noon = new Date("2026-10-16T12:00:00Z");
const lateNight = new Date("2026-10-16T23:59:59Z"); // forecast ~= current, isolates the threshold rules

describe("evaluate", () => {
  it("is ok below 60%", () => {
    expect(evaluate({ requests: 10_000, now: noon })).toMatchObject({ level: "ok", code: 0 });
  });
  it.each([[60_000, "warn", 1], [80_000, "high", 2], [90_000, "critical", 3]])("%i requests => %s", (requests, level, code) => {
    expect(evaluate({ requests, now: lateNight })).toMatchObject({ level, code });
  });
  it("any CPU-limit hit is critical regardless of request count", () => {
    const r = evaluate({ requests: 10, exceededResources: 3, now: noon });
    expect(r.code).toBe(3);
    expect(r.reasons.join(" ")).toMatch(/CPU limit/);
  });
  it("warns when CPU p99 approaches the 10 ms limit, once there are enough samples", () => {
    expect(evaluate({ requests: 2_000, cpuP99Us: 8_500, now: noon }).code).toBe(2);
    expect(evaluate({ requests: 2_000, cpuP99Us: 6_500, now: noon }).code).toBe(1);
    expect(evaluate({ requests: 2_000, cpuP99Us: 3_000, now: noon }).code).toBe(0);
    expect(evaluate({ requests: 98, cpuP99Us: 12_000, now: noon }).code).toBe(0);
  });
  it("forecasts exhaustion before it happens", () => {
    // 55k by noon extrapolates to 110k for the UTC day although currently only 55%.
    const r = evaluate({ requests: 55_000, now: noon });
    expect(r.forecast).toBe(110_000);
    expect(r.code).toBe(2);
  });
  it("does not forecast from the first minutes of the day", () => {
    expect(evaluate({ requests: 500, now: new Date("2026-10-16T00:05:00Z") }).forecast).toBeNull();
  });
});

describe("fetchUsage", () => {
  const ok = (groups) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: groups }] } } }) }));

  it("sums requests, separates CPU-limit invocations and takes the worst p99", async () => {
    const fetchImpl = ok([
      { sum: { requests: 100, errors: 0 }, quantiles: { cpuTimeP99: 4_000 }, dimensions: { status: "success" } },
      { sum: { requests: 7, errors: 7 }, quantiles: { cpuTimeP99: 12_000 }, dimensions: { status: "exceededResources" } },
    ]);
    expect(await fetchUsage({ token: "t", accountId: "a", fetchImpl, now: noon })).toMatchObject({ requests: 107, exceededResources: 7, cpuP99Us: 12_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer t");
  });

  it("fails loudly (exit 4 path) on HTTP and GraphQL errors, never reporting a false ok", async () => {
    await expect(fetchUsage({ token: "t", accountId: "a", now: noon, fetchImpl: vi.fn(async () => ({ ok: false, status: 500 })) })).rejects.toThrow(/HTTP 500/);
    await expect(fetchUsage({ token: "t", accountId: "a", now: noon, fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ errors: [{ message: "denied" }] }) })) })).rejects.toThrow(/denied/);
  });

  it("treats an empty day as zero usage", async () => {
    expect(await fetchUsage({ token: "t", accountId: "a", fetchImpl: ok([]), now: noon })).toMatchObject({ requests: 0 });
  });
});
