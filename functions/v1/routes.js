import { signRouteDirectory } from "../lib/route-signing.js";
import { loadRouteInputs } from "../lib/route-directory.js";
import { withV1User, v1Json } from "../lib/v1-http.js";
import { logger, requestIdFrom } from "../lib/logging.js";
import { raiseAlert } from "../lib/alerts.js";

/**
 * GET /v1/routes -- the signed, versioned route directory tamara-next's
 * RouteDirectoryVerifier already verifies. Requires authentication like
 * every other /v1 route, even though the directory itself carries no
 * per-user data, matching the contract's own auth model.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/routes", async (db) => {
    const log = logger(requestIdFrom(context.request), { fn: "v1/routes" });
    const inputs = await loadRouteInputs(db);
    let envelope;
    try {
      envelope = await signRouteDirectory(db, {
        ...inputs,
        privateKeyHex: context.env.ROUTE_SIGNING_PRIVATE_KEY,
        keyId: context.env.ROUTE_SIGNING_KEY_ID,
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
    return v1Json(envelope);
  });
