import { signRouteDirectory } from "../lib/route-signing.js";
import { loadRouteInputs } from "../lib/route-directory.js";
import { withV1User, v1Json } from "../lib/v1-http.js";
import { logger, requestIdFrom } from "../lib/logging.js";
import { raiseAlert } from "../lib/alerts.js";

/**
 * Perf (Phase 16 / audit "4 queries + signing per request with no
 * caching"): the route directory is the same for every caller and changes
 * only when fleet shape does (a node/location/allowed_path row), yet every
 * request re-ran 3 parallel reads, a route_directory_state read (+
 * occasional update) and an ed25519 signature. Cached module-scope (this
 * Worker isolate's lifetime, best-effort -- Cloudflare Pages Functions may
 * reuse the isolate across requests but never guarantee it) for a short TTL
 * so hot traffic amortizes that cost instead of paying it every call.
 * issued_at/expires_at inside the cached envelope stay fixed to when it was
 * signed -- still well within DIRECTORY_TTL_MS (1h) at a 30s cache TTL, so
 * clients never see an envelope closer to expiry than they would uncached.
 */
const ROUTE_CACHE_TTL_MS = 30_000;
let routeCache = null; // { envelope, expiresAtMs }

export function resetRouteCacheForTests() {
  routeCache = null;
}

async function loadSignedRouteDirectory(db, env, log) {
  const now = Date.now();
  if (routeCache && routeCache.expiresAtMs > now) return routeCache.envelope;

  const inputs = await loadRouteInputs(db);
  let envelope;
  try {
    envelope = await signRouteDirectory(db, {
      ...inputs,
      privateKeyHex: env.ROUTE_SIGNING_PRIVATE_KEY,
      keyId: env.ROUTE_SIGNING_KEY_ID,
    });
  } catch (err) {
    // F-36: a route_directory_state read/write failure here (including a
    // lost compare-and-swap race on its version column, see F-45) leaves
    // every client either stuck on a stale directory or unable to fetch
    // one at all -- worth paging on, not just a 503 to one caller.
    log.error("v1_routes.sign_failed", { error: err.message });
    await raiseAlert(db, {
      kind: "route_directory_sign_failed",
      severity: "critical",
      dedupKey: "route-directory:sign_failed",
      message: `v1/routes: signing the route directory failed: ${err.message}`,
      requestId: log.requestId,
    });
    throw err;
  }
  routeCache = { envelope, expiresAtMs: now + ROUTE_CACHE_TTL_MS };
  return envelope;
}

/**
 * GET /v1/routes -- the signed, versioned route directory tamara-next's
 * RouteDirectoryVerifier already verifies. Requires authentication like
 * every other /v1 route, even though the directory itself carries no
 * per-user data, matching the contract's own auth model.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/routes", async (db) => {
    const log = logger(requestIdFrom(context.request), { fn: "v1/routes" });
    const envelope = await loadSignedRouteDirectory(db, context.env, log);
    return v1Json(envelope);
  });
