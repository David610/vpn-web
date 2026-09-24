import { AuthRejected, passwordGrant, sessionIdOf } from "../../lib/gotrue.js";
import { adminClient } from "../../lib/account-http.js";
import { ensureSessionDevice } from "../../lib/account-service.js";
import { readV1Json, sessionBody, v1Error, v1Json } from "../../lib/v1-http.js";

/**
 * POST /v1/auth/login — { email, password, device_name?, platform? }.
 * Signs the app in with a Supabase session of its own and registers the
 * device that session belongs to. The password is passed through, never
 * stored or logged.
 */
export async function onRequestPost({ env, request }) {
  const { body, error } = await readV1Json(request);
  if (error) return error;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password || password.length > 4096) {
    return v1Error(400, "Enter your email and password.");
  }
  let session;
  try {
    session = await passwordGrant(env, email, password);
  } catch (err) {
    if (err instanceof AuthRejected) return v1Json({ message: "Wrong email or password." }, 401);
    console.error("v1/auth/login: auth service error:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
  const sessionId = sessionIdOf(session.access_token);
  try {
    await ensureSessionDevice(adminClient(env), env, { id: session.user.id, email }, sessionId, {
      name: body.device_name,
      platform: body.platform,
    });
  } catch (err) {
    console.error("v1/auth/login: device registration failed:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
  return v1Json(sessionBody(session, sessionId));
}
