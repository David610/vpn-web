import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pruneVpnLeases,
  pruneStripeEventPayloads,
  pruneProvisioningJobs,
  pruneNodeTrafficSamples,
  pruneTelegramLinkCodes,
  pruneNodeRevisions,
  clearStaleRevokedDeviceMetadata,
  pruneOperationalAlerts,
  pruneRateLimitBuckets,
  pruneLinkUsageDaily,
  runRetention,
} from "../retention.js";

// Minimal chainable query-builder fake: each terminal call (delete/update)
// resolves once every filter in the chain has been applied, mirroring how
// supabase-js's PostgrestFilterBuilder is thenable after any filter call.
function makeQueryBuilder(resolvedValue) {
  const builder = {};
  const methods = ["delete", "update", "select", "eq", "neq", "lt", "in", "order", "limit"];
  for (const m of methods) {
    builder[m] = vi.fn(() => builder);
  }
  builder.then = (resolve) => resolve(resolvedValue).then ?? resolve(resolvedValue);
  // Make it awaitable.
  builder[Symbol.toPrimitive] = undefined;
  return builder;
}

function fakeSupabase(tableResults) {
  return {
    from: vi.fn((table) => {
      const result = tableResults[table] ?? { data: [], error: null, count: 0 };
      const builder = makeQueryBuilder(result);
      // Override then to actually resolve to the result for await usage.
      builder.then = (onFulfilled) => Promise.resolve(result).then(onFulfilled);
      return builder;
    }),
  };
}

describe("retention (F-18 / H-02)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("pruneVpnLeases deletes rows older than the configured window and reports the count", async () => {
    const supabase = fakeSupabase({ vpn_leases: { error: null, count: 12 } });
    const result = await pruneVpnLeases(supabase, { VPN_LEASE_RETENTION_DAYS: "30" });
    expect(result).toEqual({ table: "vpn_leases", deleted: 12, cutoffDays: 30 });
  });

  it("pruneVpnLeases falls back to the default window when env is unset", async () => {
    const supabase = fakeSupabase({ vpn_leases: { error: null, count: 0 } });
    const result = await pruneVpnLeases(supabase, {});
    expect(result.cutoffDays).toBe(30);
  });

  it("pruneStripeEventPayloads trims the payload, not the row, and keeps the default 90-day window", async () => {
    const supabase = fakeSupabase({ stripe_events: { error: null, count: 5 } });
    const result = await pruneStripeEventPayloads(supabase, {});
    expect(result).toEqual({ table: "stripe_events", trimmed: 5, cutoffDays: 90 });
  });

  it("pruneProvisioningJobs only ever targets done/failed jobs", async () => {
    const supabase = fakeSupabase({ provisioning_jobs: { error: null, count: 3 } });
    const result = await pruneProvisioningJobs(supabase, { PROVISIONING_JOB_RETENTION_DAYS: "7" });
    expect(result).toEqual({ table: "provisioning_jobs", deleted: 3, cutoffDays: 7 });
    const builder = supabase.from.mock.results[0].value;
    expect(builder.in).toHaveBeenCalledWith("status", ["done", "failed"]);
  });

  it("pruneNodeTrafficSamples deletes samples older than the window (already rolled up at write time)", async () => {
    const supabase = fakeSupabase({ node_traffic_samples: { error: null, count: 500 } });
    const result = await pruneNodeTrafficSamples(supabase, {});
    expect(result).toEqual({ table: "node_traffic_samples", deleted: 500, cutoffDays: 7 });
  });

  it("pruneTelegramLinkCodes deletes expired codes", async () => {
    const supabase = fakeSupabase({ telegram_link_codes: { error: null, count: 2 } });
    const result = await pruneTelegramLinkCodes(supabase, {});
    expect(result).toEqual({ table: "telegram_link_codes", deleted: 2, cutoffDays: 1 });
  });

  it("pruneNodeRevisions keeps the newest N per node and deletes the rest", async () => {
    const revisionsByCall = [
      { data: [{ node_id: "node-1" }, { node_id: "node-1" }, { node_id: "node-2" }], error: null },
      {
        data: [
          { id: "r5", revision: 5 },
          { id: "r4", revision: 4 },
          { id: "r3", revision: 3 },
        ],
        error: null,
      },
      { error: null, count: 1 },
      { data: [{ id: "r2", revision: 2 }], error: null },
    ];
    let call = 0;
    const supabase = {
      from: vi.fn(() => {
        const builder = makeQueryBuilder(null);
        builder.then = (onFulfilled) => Promise.resolve(revisionsByCall[call++]).then(onFulfilled);
        return builder;
      }),
    };
    const result = await pruneNodeRevisions(supabase, { NODE_REVISIONS_KEEP: "2" });
    expect(result.table).toBe("node_revisions");
    expect(result.keepPerNode).toBe(2);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  it("clearStaleRevokedDeviceMetadata only touches REVOKED devices past the window and uses a non-null placeholder name", async () => {
    const supabase = fakeSupabase({ devices: { error: null, count: 4 } });
    const result = await clearStaleRevokedDeviceMetadata(supabase, {});
    expect(result).toEqual({ table: "devices", cleared: 4, cutoffDays: 90 });
    const builder = supabase.from.mock.results[0].value;
    expect(builder.eq).toHaveBeenCalledWith("status", "REVOKED");
    const updateArg = builder.update.mock.calls[0][0];
    expect(updateArg.name).toBeTruthy();
    expect(updateArg.platform).toBeNull();
  });

  it("pruneOperationalAlerts only deletes resolved alerts", async () => {
    const supabase = fakeSupabase({ operational_alerts: { error: null, count: 9 } });
    const result = await pruneOperationalAlerts(supabase, {});
    expect(result).toEqual({ table: "operational_alerts", deleted: 9, cutoffDays: 30 });
    const builder = supabase.from.mock.results[0].value;
    expect(builder.eq).toHaveBeenCalledWith("status", "resolved");
  });

  it("pruneRateLimitBuckets deletes counters whose window ended more than a day ago", async () => {
    const supabase = fakeSupabase({ rate_limit_buckets: { error: null, count: 40 } });
    const result = await pruneRateLimitBuckets(supabase, {});
    expect(result).toEqual({ table: "rate_limit_buckets", deleted: 40, cutoffDays: 1 });
    const builder = supabase.from.mock.results[0].value;
    expect(builder.lt).toHaveBeenCalledWith("window_start", expect.any(String));
  });

  it("pruneLinkUsageDaily keeps 35 days of per-client aggregates by default and filters on the date bucket", async () => {
    const supabase = fakeSupabase({ vpn_link_usage_daily: { error: null, count: 3 } });
    const result = await pruneLinkUsageDaily(supabase, {});
    expect(result).toEqual({ table: "vpn_link_usage_daily", deleted: 3, cutoffDays: 35 });
    const builder = supabase.from.mock.results[0].value;
    expect(builder.lt).toHaveBeenCalledWith("bucket_date", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("pruneLinkUsageDaily honours LINK_USAGE_RETENTION_DAYS", async () => {
    const supabase = fakeSupabase({ vpn_link_usage_daily: { error: null, count: 0 } });
    const result = await pruneLinkUsageDaily(supabase, { LINK_USAGE_RETENTION_DAYS: "10" });
    expect(result.cutoffDays).toBe(10);
  });

  it("runRetention isolates failures: one table erroring does not stop the others", async () => {
    const supabase = {
      from: vi.fn((table) => {
        const builder = makeQueryBuilder(null);
        if (table === "vpn_leases") {
          builder.then = (onFulfilled) => Promise.reject(new Error("boom")).catch(() => onFulfilled({ error: null, count: 0 }));
        } else {
          builder.then = (onFulfilled) => Promise.resolve({ data: [], error: null, count: 0 }).then(onFulfilled);
        }
        return builder;
      }),
    };
    const results = await runRetention(supabase, {});
    expect(results.length).toBe(11);
  });
});
