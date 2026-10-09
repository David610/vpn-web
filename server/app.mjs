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

export function createApp({ functionsDir, env, publicOrigin, corsOrigins = [], trustedProxyHops = 0, log = () => {} }) {
  const routes = discoverRoutes(functionsDir);
  const allowedOrigins = new Set(corsOrigins);

  async function handle({ method, path, search, headers, body, remoteAddress, host }) {
    const pathname = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const origin = headers.get("origin");
    const browserApi = pathname.startsWith("/api/");

    if (pathname === "/healthz") return json(200, { ok: true });
    if (method === "OPTIONS" && browserApi) return preflight(origin, allowedOrigins);

    const match = matchRoute(routes, pathname);
    if (!match) return json(404, { error: "Not found" });
    const { route, params } = match;
    const handlerMethod = method === "HEAD" && !route.methods.has("HEAD") ? "GET" : method;
    if (!route.methods.has(handlerMethod) && !route.methods.has("ANY")) {
      const allow = [...route.methods].filter((m) => m !== "ANY").join(", ");
      return json(405, { error: "Method not allowed" }, { Allow: allow });
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
    });

    try {
      const handler = await loadHandler(route, handlerMethod);
      const response = await handler({ request, env, params, data: {}, waitUntil: (promise) => { promise?.catch?.(() => {}); }, next: async () => json(404, { error: "Not found" }) });
      const finished = method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      return browserApi ? withCors(finished, origin, allowedOrigins) : finished;
    } catch (error) {
      log({ level: "error", route: pathname, error: error?.name ?? "Error" });
      return json(500, { error: "Internal error" });
    }
  }

  return { handle, routeCount: routes.length };
}
