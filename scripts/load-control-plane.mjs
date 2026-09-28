#!/usr/bin/env node

/**
 * Lightweight control-plane load test with no external dependencies.
 *
 * Required:
 *   ARCANA_BASE_URL=https://...
 *   ARCANA_ACCESS_TOKEN=...
 *
 * Optional:
 *   CONCURRENCY=100
 *   DURATION_SECONDS=30
 *   ENDPOINT=/api/vpn/config
 *
 * Uses one real authenticated account, so it measures Worker/Auth/PostgREST
 * request handling rather than signup or Stripe side effects.
 *
 * --- Reconcile / K-02 hand-off note ---
 *
 * K-02 (audit F-30/F-43/F-50, cross-repo plan K-02) asks specifically for a
 * measurement of `reconcileAccountProvisioning` (functions/lib/device-provisioning.js),
 * which is exclusive CP-BILL territory under the cross-repo remediation
 * plan's file-ownership table (§6) — this script does not and should not
 * import or call into it directly.
 *
 * What this script CAN do, unmodified, to produce the K-02 measurement:
 * point ENDPOINT at whichever `/v1` or `/api` route triggers
 * reconcileAccountProvisioning on the request path — at the time of the
 * audit that's a device add/remove or pack-change endpoint — and read the
 * wall-clock p50/p95/p99 this script already reports. That end-to-end
 * latency is a proxy for the reconcile cost (plus everything else the route
 * does), which is exactly what's needed to see whether the N+1 query
 * pattern (3-8 sequential queries per device, up to the 60-device cap) shows
 * up as a latency cliff under load. It cannot report a *query count* per
 * call — that needs either a Supabase log export or CP-BILL adding a
 * counter inside reconcileAccountProvisioning itself.
 *
 * Example: ENDPOINT=/api/vpn/devices CONCURRENCY=60 DURATION_SECONDS=30 \
 *   ARCANA_BASE_URL=... ARCANA_ACCESS_TOKEN=... node scripts/load-control-plane.mjs
 *
 * This was NOT run against production for this remediation pass: it needs a
 * real ARCANA_ACCESS_TOKEN and a disposable test account/device set (running
 * it against a real account repeatedly adds/removes devices), neither of
 * which this task has access to. Handing off to CP-BILL/RELQA with the
 * concrete recommendation below instead of fabricating numbers.
 *
 * Recommendation for CP-BILL (from reading device-provisioning.js): the
 * `for (const device of devices) { await reconcileDeviceProvisioning(...) }`
 * loop in reconcileAccountProvisioning is sequential and awaits each device
 * fully before starting the next. The straightforward fix is not adding
 * concurrency to that loop (that would multiply concurrent writes to the
 * same node's lease pool) but collapsing the *reads* out of the loop: batch
 * the per-device entitlement/identity/lease lookups into one `.in("device_id", deviceIds)`
 * query each (loadDeviceEntitlements already does this for entitlements;
 * the same pattern should extend to whatever per-device lookups
 * reconcileDeviceProvisioning still does per iteration), so the query count
 * for N devices goes from O(N) round trips to O(1) per query type,
 * independent of the 60-device cap.
 */

const baseUrl = process.env.ARCANA_BASE_URL?.replace(/\/$/, "");
const token = process.env.ARCANA_ACCESS_TOKEN;
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 100));
const durationSeconds = Math.max(5, Number(process.env.DURATION_SECONDS ?? 30));
const endpoint = process.env.ENDPOINT ?? "/api/vpn/config";

if (!baseUrl || !token) {
  console.error("Set ARCANA_BASE_URL and ARCANA_ACCESS_TOKEN.");
  process.exit(2);
}

const deadline = Date.now() + durationSeconds * 1000;
const latencies = [];
let ok = 0;
let failed = 0;
const failures = new Map();

async function worker() {
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      // Always consume the body so keep-alive connections can be reused.
      await res.arrayBuffer();
      latencies.push(performance.now() - started);
      if (res.ok) {
        ok += 1;
      } else {
        failed += 1;
        failures.set(res.status, (failures.get(res.status) ?? 0) + 1);
      }
    } catch (err) {
      latencies.push(performance.now() - started);
      failed += 1;
      const key = err?.name ?? "network";
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedSeconds = (performance.now() - startedAt) / 1000;

latencies.sort((a, b) => a - b);
const percentile = (p) => {
  if (!latencies.length) return 0;
  const index = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1);
  return latencies[index];
};

const total = ok + failed;
const result = {
  endpoint,
  concurrency,
  durationSeconds,
  requests: total,
  success: ok,
  failed,
  errorRate: total ? failed / total : 1,
  requestsPerSecond: total / elapsedSeconds,
  latencyMs: {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    max: latencies.at(-1) ?? 0,
  },
  failures: Object.fromEntries(failures),
};

console.log(JSON.stringify(result, null, 2));

if (result.errorRate > 0.01) {
  console.error("FAIL: error rate exceeded 1%");
  process.exit(1);
}
if (result.latencyMs.p95 > 1500) {
  console.error("FAIL: p95 latency exceeded 1500ms");
  process.exit(1);
}
