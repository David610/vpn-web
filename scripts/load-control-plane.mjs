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
