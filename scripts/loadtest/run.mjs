#!/usr/bin/env node
// Load/behaviour test of the REAL server/index.mjs against the mock backend.
//   node scripts/loadtest/run.mjs [--concurrency 25,100,300] [--latency-ms 20] [--seconds 6]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startMockSupabase } from "./mock-supabase.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const levels = arg("concurrency", "25,100,300").split(",").map(Number);
const latencyMs = Number(arg("latency-ms", "20"));
const seconds = Number(arg("seconds", "6"));
const port = Number(arg("port", "18787"));
const encKey = "00".repeat(32);

const mock = await startMockSupabase({ latencyMs, nodes: 3, authorizationsPerNode: 12 });
const child = spawn(process.execPath, ["server/index.mjs"], {
  env: {
    ...process.env, API_PORT: String(port), API_HOST: "127.0.0.1", API_ROUTE_PREFIXES: "/api/agent",
    SUPABASE_URL: mock.url, SUPABASE_SERVICE_ROLE_KEY: "service", VPN_SECRETS_ENCRYPTION_KEY: encKey,
    METRICS_TOKEN: "load", MAX_IN_FLIGHT: "1000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", () => {});
for (let i = 0; i < 50; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const headers = (i) => ({ Authorization: `Bearer key-${i % 3}`, "Content-Type": "application/json" });
const base = `http://127.0.0.1:${port}`;
const results = [];

async function scenario(name, concurrency, makeRequest) {
  const latencies = [];
  let errors = 0;
  const deadline = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await makeRequest(worker);
        if (res.status >= 500 || res.status === 429) errors += 1;
        await res.arrayBuffer();
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - t0);
    }
  }));
  latencies.sort((a, b) => a - b);
  results.push({
    scenario: name, concurrency, requests: latencies.length, rps: Math.round(latencies.length / seconds),
    p50: Math.round(pct(latencies, 0.5)), p95: Math.round(pct(latencies, 0.95)), p99: Math.round(pct(latencies, 0.99)), errors,
  });
}

for (const c of levels) {
  await scenario("authorizations (full)", c, (w) => fetch(`${base}/api/agent/authorizations?schema=2`, { headers: headers(w) }));
  const etags = new Map();
  await scenario("authorizations (If-None-Match)", c, async (w) => {
    let etag = etags.get(w % 3);
    if (!etag) {
      const first = await fetch(`${base}/api/agent/authorizations?schema=2`, { headers: headers(w) });
      etag = first.headers.get("etag");
      etags.set(w % 3, etag);
      await first.arrayBuffer();
    }
    return fetch(`${base}/api/agent/authorizations?schema=2`, { headers: { ...headers(w), "If-None-Match": etag } });
  });
  await scenario("claim (idle)", c, (w) => fetch(`${base}/api/agent/claim`, { method: "POST", headers: headers(w), body: "{}" }));
}

const metrics = await (await fetch(`${base}/metrics`, { headers: { Authorization: "Bearer load" } })).json();
child.kill("SIGTERM");
await once(child, "exit");
console.table(results);
console.log("mock backend calls by route:", Object.fromEntries(mock.state.calls));
console.log("server-side p95 upper bounds (ms):", Object.fromEntries(Object.entries(metrics.latencyMs).map(([k, v]) => [k, v.p95UpperBound])));
await mock.close();
const worst = Math.max(...results.map((r) => r.p95));
console.log(`worst client-observed p95: ${worst} ms (target < 500 ms with ${latencyMs} ms simulated DB latency per call)`);
process.exit(results.some((r) => r.errors > 0) || worst >= 500 ? 1 : 0);
