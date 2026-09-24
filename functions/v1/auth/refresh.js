import { AuthRejected, refreshGrant, sessionIdOf } from "../../lib/gotrue.js";
import { readV1Json, sessionBody, v1Error, v1Json } from "../../lib/v1-http.js";

/** POST /v1/auth/refresh — { refresh_token }. 401 invalidates the device session. */
export async function onRequestPost({ env, request }) {
  const { body, error } = await readV1Json(request);
  if (error) return error;
  const token = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
  if (!token || token.length > 8192) return v1Json({ message: "Please log in again." }, 401);
  try {
    const session = await refreshGrant(env, token);
    return v1Json(sessionBody(session, sessionIdOf(session.access_token)));
  } catch (err) {
    if (err instanceof AuthRejected) return v1Json({ message: "Please log in again." }, 401);
    console.error("v1/auth/refresh: auth service error:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
}
