import { AuthRejected, refreshGrant, sessionIdOf } from "../../lib/gotrue.js";
import { readV1Json, sessionBody, v1Error, v1Json } from "../../lib/v1-http.js";
import { adminClient } from "../../lib/account-http.js";
import { checkRateLimit, rateLimitedResponse, clientIpKey } from "../../lib/rate-limit.js";
import { sha256Hex } from "../../lib/crypto.js";

// F-13: keyed primarily by the refresh token itself (hashed — the raw
// token is a bearer secret and must never be stored, even in a rate-limit
// bucket key) so a stolen/guessed token can't be hammered past GoTrue's own
// throttling; a generous IP backstop catches broader abuse.
const REFRESH_WINDOW_SECONDS = 15 * 60;
const REFRESH_LIMIT_PER_TOKEN = 20;
const REFRESH_LIMIT_PER_IP = 120;

/** POST /v1/auth/refresh — { refresh_token }. 401 invalidates the device session. */
export async function onRequestPost({ env, request }) {
  const { body, error } = await readV1Json(request);
  if (error) return error;
  const token = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
  if (!token || token.length > 8192) return v1Json({ message: "Please log in again." }, 401);

  const supabaseAdmin = adminClient(env);
  const tokenAllowed = await checkRateLimit(supabaseAdmin, `v1-refresh:token:${await sha256Hex(token)}`, {
    windowSeconds: REFRESH_WINDOW_SECONDS,
    limit: REFRESH_LIMIT_PER_TOKEN,
  });
  const ipAllowed = await checkRateLimit(supabaseAdmin, `v1-refresh:ip:${clientIpKey(request)}`, {
    windowSeconds: REFRESH_WINDOW_SECONDS,
    limit: REFRESH_LIMIT_PER_IP,
  });
  if (!tokenAllowed || !ipAllowed) {
    return rateLimitedResponse("Too many attempts. Please try again later.");
  }

  try {
    const session = await refreshGrant(env, token);
    return v1Json(sessionBody(session, sessionIdOf(session.access_token)));
  } catch (err) {
    if (err instanceof AuthRejected) return v1Json({ message: "Please log in again." }, 401);
    console.error("v1/auth/refresh: auth service error:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
}
