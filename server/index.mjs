import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { hubFromEnv } from "./event-source.mjs";
import { configureNodeAuthCache } from "../functions/lib/node-auth.js";
import { configureNodeTouchThrottle } from "../functions/lib/node-touch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const list = (value) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const port = Number(env.API_PORT ?? 8787);
const host = env.API_HOST ?? "127.0.0.1";
const maxBodyBytes = Number(env.MAX_BODY_BYTES ?? 1024 * 1024);
const trustedProxyHops = Number(env.TRUSTED_PROXY_HOPS ?? 0);
const corsOrigins = list(env.CORS_ALLOWED_ORIGINS);
const routePrefixes = list(env.API_ROUTE_PREFIXES);
const maxInFlight = Number(env.MAX_IN_FLIGHT ?? 256);
const shutdownGraceMs = Number(env.SHUTDOWN_GRACE_MS ?? 10_000);

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VPN_SECRETS_ENCRYPTION_KEY"];
// The subscription gateway is the only consumer of the token hash key; an
// agent-only deployment (API_ROUTE_PREFIXES=/api/agent) does not need it, so
// it is not handed to that process.
if (routePrefixes.length === 0) required.push("SUBSCRIPTION_TOKEN_HASH_KEY");
for (const name of required) {
  if (!env[name]) { console.error(`${name} is required`); process.exit(1); }
}
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) { console.error("TRUSTED_PROXY_HOPS must be a non-negative integer"); process.exit(1); }
if (!Number.isInteger(maxInFlight) || maxInFlight < 1) { console.error("MAX_IN_FLIGHT must be a positive integer"); process.exit(1); }

// A revoked or quarantined node stays accepted for at most this long.
configureNodeAuthCache({ ttlMs: Number(env.NODE_AUTH_TTL_MS ?? 5_000), negativeTtlMs: 1_000 });

configureNodeTouchThrottle(Number(env.NODE_TOUCH_INTERVAL_MS ?? 30_000));

const hub = hubFromEnv(env);

const app = createApp({
  functionsDir: path.resolve(here, env.FUNCTIONS_DIR ?? "../functions"),
  env: { ...env, AGENT_EVENT_HUB: hub },
  publicOrigin: env.PUBLIC_API_ORIGIN || undefined,
  corsOrigins,
  trustedProxyHops,
  routePrefixes,
  maxInFlight,
  metricsToken: env.METRICS_TOKEN ?? "",
  log: (entry) => console.error(JSON.stringify(entry)),
});

class BodyTooLarge extends Error {}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return size === 0 ? undefined : Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  // A closed connection must free its long-poll slot immediately.
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const response = await app.handle({
      method: req.method ?? "GET",
      path: url.pathname,
      search: url.search,
      headers: new Headers(Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]]))),
      body,
      remoteAddress: req.socket.remoteAddress,
      host: req.headers.host,
      signal: controller.signal,
    });
    const headers = {};
    for (const [key, value] of response.headers) if (key !== "set-cookie") headers[key] = value;
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error instanceof BodyTooLarge ? 413 : 500;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: status === 413 ? "Request too large" : "Internal error" }));
  }
});

// Long polls last up to 30 s; slow-header and idle-socket attacks must not hold slots.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(port, host, () => console.error(JSON.stringify({ level: "info", msg: "listening", host, port, routes: app.routeCount, prefixes: routePrefixes })));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), shutdownGraceMs).unref();
  });
}
