import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const port = Number(env.API_PORT ?? 8787);
const host = env.API_HOST ?? "127.0.0.1";
const maxBodyBytes = Number(env.MAX_BODY_BYTES ?? 1024 * 1024);
const trustedProxyHops = Number(env.TRUSTED_PROXY_HOPS ?? 0);
const corsOrigins = (env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUBSCRIPTION_TOKEN_HASH_KEY", "VPN_SECRETS_ENCRYPTION_KEY"]) {
  if (!env[name]) { console.error(`${name} is required`); process.exit(1); }
}
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0) { console.error("TRUSTED_PROXY_HOPS must be a non-negative integer"); process.exit(1); }

const app = createApp({
  functionsDir: path.resolve(here, env.FUNCTIONS_DIR ?? "../functions"),
  env,
  publicOrigin: env.PUBLIC_API_ORIGIN || undefined,
  corsOrigins,
  trustedProxyHops,
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

server.listen(port, host, () => console.error(JSON.stringify({ level: "info", msg: "listening", host, port, routes: app.routeCount })));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
