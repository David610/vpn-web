import { signRouteDirectory } from "../lib/route-signing.js";
import { loadRouteInputs } from "../lib/route-directory.js";
import { withV1User, v1Json } from "../lib/v1-http.js";

/**
 * GET /v1/routes -- the signed, versioned route directory tamara-next's
 * RouteDirectoryVerifier already verifies. Requires authentication like
 * every other /v1 route, even though the directory itself carries no
 * per-user data, matching the contract's own auth model.
 */
export const onRequestGet = (context) =>
  withV1User(context, "v1/routes", async (db) => {
    const inputs = await loadRouteInputs(db);
    const envelope = await signRouteDirectory(db, {
      ...inputs,
      privateKeyHex: context.env.ROUTE_SIGNING_PRIVATE_KEY,
      keyId: context.env.ROUTE_SIGNING_KEY_ID,
    });
    return v1Json(envelope);
  });
