import { discoverRoutes, loadHandler, matchRoute } from "./routes.mjs";

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Telegram-Init-Data";

export function resolveClientIp({ remoteAddress, forwardedFor, trustedProxyHops }) {
  if (!trustedProxyHops) return remoteAddress || "unknown";
  const chain = (forwardedFor ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return chain.at(-trustedProxyHops) || remoteAddress || "unknown";
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function withCors(response, origin, corsOrigins) {
  if (!origin || !corsOrigins.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(origin, corsOrigins) {
  if (!origin || !corsOrigins.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": CORS_METHODS,
      "Access-Control-Allow-Headers": CORS_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

function templateOf(route) {
  return `/${route.pattern.map((part) => ("param" in part ? `:${part.param}` : part.literal)).join("/")}`;
}

function statusClass(status) {
  return `${Math.floor(status / 100)}xx`;
}

export function createApp({
  functionsDir, env, publicOrigin, corsOrigins = [], trustedProxyHops = 0, log = () => {},
  routePrefixes = [], maxInFlight = Infinity, metricsToken = "", longPollRoutes = ["/api/agent/events"], now = () => performance.now(),
}) {
  const routes = discoverRoutes(functionsDir).filter(
    (route) => routePrefixes.length === 0 || routePrefixes.some((prefix) => {
      const template = templateOf(route);
      return template === prefix || template.startsWith(`${prefix}/`);
    }),
  );
  const allowedOrigins = new Set(corsOrigins);
  const longPoll = new Set(longPollRoutes);
  let inFlight = 0;
  const requests = new Map();
  const latency = new Map();

  function record(method, template, status, ms) {
    const key = `${method} ${template} ${statusClass(status)}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    if (longPoll.has(template)) return;
    const label = `${method} ${template}`;
    const entry = latency.get(label) ?? { count: 0, sumMs: 0, buckets: LATENCY_BUCKETS_MS.map(() => 0), over: 0 };
    entry.count += 1;
    entry.sumMs += ms;
    const slot = LATENCY_BUCKETS_MS.findIndex((limit) => ms <= limit);
    if (slot === -1) entry.over += 1; else entry.buckets[slot] += 1;
    latency.set(label, entry);
  }

  function p95(entry) {
    const target = Math.ceil(entry.count * 0.95);
    let seen = 0;
    for (const [i, limit] of LATENCY_BUCKETS_MS.entries()) {
      seen += entry.buckets[i];
      if (seen >= target) return limit;
    }
    return Infinity;
  }

  function metrics() {
    return json(200, {
      inFlight,
      requests: Object.fromEntries(requests),
      latencyMs: Object.fromEntries([...latency].map(([label, e]) => [label, {
        count: e.count, avg: Math.round(e.sumMs / e.count), p95UpperBound: p95(e), over5000: e.over,
      }])),
    });
  }

  async function handle({ method, path, search, headers, body, remoteAddress, host, signal }) {
    const pathname = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const origin = headers.get("origin");
    const browserApi = pathname.startsWith("/api/");

    if (pathname === "/healthz") return json(200, { ok: true });
    if (pathname === "/metrics" && metricsToken) {
      const presented = headers.get("authorization") ?? "";
      return presented === `Bearer ${metricsToken}` ? metrics() : json(401, { error: "Unauthorized" });
    }
    if (method === "OPTIONS" && browserApi) return preflight(origin, allowedOrigins);

    const match = matchRoute(routes, pathname);
    if (!match) return json(404, { error: "Not found" });
    const { route, params } = match;
    if (inFlight >= maxInFlight) return json(503, { error: "Server busy" }, { "Retry-After": "2" });
    inFlight += 1;
    const started = now();
    const template = templateOf(route);
    const finish = (response) => {
      inFlight -= 1;
      const ms = Math.round(now() - started);
      record(method, template, response.status, ms);
      log({ level: "info", msg: "request", method, route: template, status: response.status, ms });
      return response;
    };
    const handlerMethod = method === "HEAD" && !route.methods.has("HEAD") ? "GET" : method;
    if (!route.methods.has(handlerMethod) && !route.methods.has("ANY")) {
      const allow = [...route.methods].filter((m) => m !== "ANY").join(", ");
      return finish(json(405, { error: "Method not allowed" }, { Allow: allow }));
    }

    const requestHeaders = new Headers(headers);
    requestHeaders.delete("cf-connecting-ip");
    requestHeaders.delete("x-forwarded-for");
    requestHeaders.set("cf-connecting-ip", resolveClientIp({
      remoteAddress,
      forwardedFor: headers.get("x-forwarded-for"),
      trustedProxyHops,
    }));

    const base = publicOrigin ?? `http://${host ?? "localhost"}`;
    const hasBody = handlerMethod !== "GET" && handlerMethod !== "HEAD" && body !== undefined;
    const request = new Request(new URL(`${pathname}${search}`, base), {
      method: handlerMethod,
      headers: requestHeaders,
      body: hasBody ? body : undefined,
      signal,
    });

    try {
      const handler = await loadHandler(route, handlerMethod);
      const response = await handler({ request, env, params, data: {}, waitUntil: (promise) => { promise?.catch?.(() => {}); }, next: async () => json(404, { error: "Not found" }) });
      const finished = method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      return finish(browserApi ? withCors(finished, origin, allowedOrigins) : finished);
    } catch (error) {
      log({ level: "error", route: pathname, error: error?.name ?? "Error" });
      if (error?.status === 503) return finish(json(503, { error: "Temporarily unavailable" }, { "Retry-After": "5" }));
      return finish(json(500, { error: "Internal error" }));
    }
  }

  return { handle, routeCount: routes.length };
}
