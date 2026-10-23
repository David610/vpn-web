#!/usr/bin/env node
// Lightweight Cloudflare Workers/Pages-Functions quota check.
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/cloudflare-quota-check.mjs [--json]
// One GraphQL request per run (not a Workers request, no state). Exit codes:
//   0 ok (<60%)  1 warn (>=60%)  2 high (>=80%)  3 critical (>=90% or CPU limit hit)  4 could not check
// Run it from cron/systemd on the VPS every 15 minutes; alert delivery is the
// caller's job (e.g. the existing Telegram/alert channel) and must NOT call
// back into Cloudflare Workers.

export const DAILY_REQUEST_LIMIT = 100_000;
export const CPU_LIMIT_US = 10_000;
// p99 of a handful of requests is noise; real limit hits (exceededResources) always count.
const MIN_SAMPLES_FOR_P99 = 1_000;
const LEVELS = [
  { at: 0.9, name: "critical", code: 3 },
  { at: 0.8, name: "high", code: 2 },
  { at: 0.6, name: "warn", code: 1 },
];

export function evaluate({ requests, exceededResources = 0, cpuP99Us = 0, now = new Date() }) {
  const ratio = requests / DAILY_REQUEST_LIMIT;
  let level = { name: "ok", code: 0 };
  for (const candidate of LEVELS) {
    if (ratio >= candidate.at) { level = candidate; break; }
  }
  const reasons = [];
  if (level.code > 0) reasons.push(`requests ${requests}/${DAILY_REQUEST_LIMIT} (${Math.round(ratio * 100)}%)`);
  if (exceededResources > 0) {
    reasons.push(`${exceededResources} invocations exceeded the CPU limit today`);
    level = { name: "critical", code: 3 };
  } else if (requests >= MIN_SAMPLES_FOR_P99 && cpuP99Us >= CPU_LIMIT_US * 0.8) {
    reasons.push(`CPU p99 ${Math.round(cpuP99Us / 1000)} ms is within 20% of the ${CPU_LIMIT_US / 1000} ms limit`);
    if (level.code < 2) level = { name: "high", code: 2 };
  } else if (requests >= MIN_SAMPLES_FOR_P99 && cpuP99Us >= CPU_LIMIT_US * 0.6 && level.code < 1) {
    reasons.push(`CPU p99 ${Math.round(cpuP99Us / 1000)} ms is above 60% of the limit`);
    level = { name: "warn", code: 1 };
  }
  // Forecast: linear extrapolation of today's rate to the end of the UTC day.
  const secondsToday = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const forecast = secondsToday > 900 ? Math.round((requests / secondsToday) * 86_400) : null;
  if (forecast !== null && forecast >= DAILY_REQUEST_LIMIT && level.code < 2) {
    reasons.push(`forecast for the UTC day: ${forecast} requests`);
    level = { name: "high", code: 2 };
  }
  return { level: level.name, code: level.code, requests, exceededResources, cpuP99Us, forecast, reasons };
}

export async function fetchUsage({ token, accountId, fetchImpl = fetch, now = new Date() }) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const query = `{viewer{accounts(filter:{accountTag:"${accountId}"}){pagesFunctionsInvocationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${start}",datetime_leq:"${now.toISOString()}"}){sum{requests errors} quantiles{cpuTimeP99} dimensions{status}}}}}`;
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GraphQL error: ${body.errors[0].message}`);
  const groups = body.data?.viewer?.accounts?.[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? [];
  let requests = 0;
  let exceededResources = 0;
  let cpuP99Us = 0;
  for (const group of groups) {
    requests += group.sum.requests;
    if (group.dimensions.status === "exceededResources") exceededResources += group.sum.requests;
    cpuP99Us = Math.max(cpuP99Us, group.quantiles?.cpuTimeP99 ?? 0);
  }
  return { requests, exceededResources, cpuP99Us, now };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("cloudflare-quota-check.mjs")) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error("CF_API_TOKEN and CF_ACCOUNT_ID are required");
    process.exit(4);
  }
  try {
    const result = evaluate(await fetchUsage({ token, accountId }));
    console.log(process.argv.includes("--json") ? JSON.stringify(result) : `${result.level}: ${result.requests} req today, CPU p99 ${Math.round(result.cpuP99Us / 1000)} ms${result.reasons.length ? ` — ${result.reasons.join("; ")}` : ""}`);
    process.exit(result.code);
  } catch (error) {
    console.error(`quota check failed: ${error.message}`);
    process.exit(4);
  }
}
