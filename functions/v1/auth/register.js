import { AuthRejected, sessionIdOf, signUp } from "../../lib/gotrue.js";
import { adminClient } from "../../lib/account-http.js";
import { ensureSessionDevice } from "../../lib/account-service.js";
import { readV1Json, sessionBody, v1Error, v1Json } from "../../lib/v1-http.js";

const MIN_PASSWORD = 12;

/**
 * POST /v1/auth/register — { email, password }. 201 with a session when the
 * project signs new users in immediately; 202 { confirmation_required }
 * when the email must be confirmed first.
 */
export async function onRequestPost({ env, request }) {
  const { body, error } = await readV1Json(request);
  if (error) return error;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return v1Error(400, "Enter a valid email.");
  if (password.length < MIN_PASSWORD || password.length > 4096) {
    return v1Error(400, `Use at least ${MIN_PASSWORD} characters for your password.`);
  }
  let session;
  try {
    session = await signUp(env, email, password);
  } catch (err) {
    if (err instanceof AuthRejected) {
      return v1Error(409, "Could not create an account with that email.");
    }
    console.error("v1/auth/register: auth service error:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
  if (!session) {
    return v1Json(
      { confirmation_required: true, message: "Check your email to confirm your account, then log in." },
      202
    );
  }
  const sessionId = sessionIdOf(session.access_token);
  try {
    await ensureSessionDevice(adminClient(env), env, { id: session.user.id, email }, sessionId, {});
  } catch (err) {
    console.error("v1/auth/register: device registration failed:", err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
  return v1Json(sessionBody(session, sessionId), 201);
}
