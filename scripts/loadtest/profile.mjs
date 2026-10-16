#!/usr/bin/env node
// CPU-profile the real server under a short authorizations load and print the
// top self-time frames.  node scripts/loadtest/profile.mjs [--concurrency 100] [--seconds 5]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockSupabase } from "./mock-supabase.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const concurrency = Number(arg("concurrency", "100"));
const seconds = Number(arg("seconds", "5"));
const port = 18788;
const out = mkdtempSync(path.join(os.tmpdir(), "arcana-prof-"));
const mock = await startMockSupabase({ latencyMs: 20 });
const child = spawn(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${out}`, "--input-type=module", "-e", `await import("./server/index.mjs"); setTimeout(() => process.exit(0), ${(seconds + 3) * 1000});`], {
  env: {
    ...process.env, API_PORT: String(port), API_HOST: "127.0.0.1", API_ROUTE_PREFIXES: "/api/agent",
    SUPABASE_URL: mock.url, SUPABASE_SERVICE_ROLE_KEY: "service", VPN_SECRETS_ENCRYPTION_KEY: "00".repeat(32), MAX_IN_FLIGHT: "1000",
  },
  stdio: ["ignore", "ignore", "ignore"],
});
for (let i = 0; i < 50; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const deadline = Date.now() + seconds * 1000;
let done = 0;
await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/authorizations?schema=2`, { headers: { Authorization: `Bearer key-${w % 3}` } });
    await res.arrayBuffer();
    done += 1;
  }
}));
await once(child, "exit");
await mock.close();
const file = readdirSync(out).find((f) => f.endsWith(".cpuprofile"));
const profile = JSON.parse(readFileSync(path.join(out, file), "utf8"));
const self = new Map();
const dt = profile.timeDeltas;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`requests completed: ${done}, profiled CPU: ${(total / 1000).toFixed(0)} ms`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
rmSync(out, { recursive: true, force: true });
