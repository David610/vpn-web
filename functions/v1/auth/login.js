import { AuthRejected, passwordGrant, sessionIdOf } from "../../lib/gotrue.js";
import { adminClient } from "../../lib/account-http.js";
import { ensureSessionDevice } from "../../lib/account-service.js";
import { readV1Json, sessionBody, v1Error, v1Json } from "../../lib/v1-http.js";
import { checkRateLimit, rateLimitedResponse, clientIpKey } from "../../lib/rate-limit.js";

// F-13: the app's login endpoint had no throttle at all — a credential-
// stuffing run against it was limited only by GoTrue's own (much coarser)
// protections. Keyed primarily by the email being authenticated against,
// since many real users share a NAT/carrier IP (F-49's rate-limit.js module
// comment); a much more generous IP backstop catches a single attacker
// cycling through many different email addresses from one source.
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_LIMIT_PER_EMAIL = 10;
const LOGIN_LIMIT_PER_IP = 60;

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

  const supabaseAdmin = adminClient(env);
  const emailAllowed = await checkRateLimit(supabaseAdmin, `v1-login:email:${email}`, {
    windowSeconds: LOGIN_WINDOW_SECONDS,
    limit: LOGIN_LIMIT_PER_EMAIL,
    env,
  });
  const ipAllowed = await checkRateLimit(supabaseAdmin, `v1-login:ip:${clientIpKey(request)}`, {
    windowSeconds: LOGIN_WINDOW_SECONDS,
    limit: LOGIN_LIMIT_PER_IP,
    env,
  });
  if (!emailAllowed || !ipAllowed) {
    return rateLimitedResponse("Too many login attempts. Please try again later.");
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
    await ensureSessionDevice(supabaseAdmin, env, { id: session.user.id, email }, sessionId, {
      name: body.device_name,
      platform: body.platform,
    });
  } catch (err) {
    console.error("v1/auth/login: device registration failed:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
  return v1Json(sessionBody(session, sessionId));
}
