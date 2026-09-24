/**
 * HTTP conventions of the Arcana app API (/v1), per
 * tamara-next docs/contracts/managed-control-plane-v1.md:
 *  - 401/403 mean the session is no longer valid (the app signs out);
 *  - 404/405/501 mean "this endpoint is not offered" (the app falls back
 *    to the website), so a missing ITEM is reported as 409, never 404;
 *  - 400/409/422 carry a short user-safe { message }.
 */
import { adminClient } from "./account-http.js";
import { requireUser } from "./user-auth.js";

export function v1Json(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? { "Cache-Control": "no-store" } : {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const noContent = () => v1Json(null, 204);

export function v1Error(status, message, code) {
  return v1Json({ message, ...(code ? { code } : {}) }, status);
}

/** Maps an account-service { status, body } onto the app contract. */
export function fromService({ status, body }, successStatus = 204) {
  if (status < 400) return successStatus === 204 ? noContent() : v1Json(body, successStatus);
  const message = body?.error ?? "Arcana could not complete that request.";
  if (status === 404) return v1Error(409, message, "not_found");
  if (status === 403 || status === 401) return v1Error(422, message, body?.code);
  if (status >= 500) return v1Error(503, message);
  return v1Error(status === 400 ? 400 : status === 409 ? 409 : 422, message, body?.code);
}

export async function readV1Json(request) {
  try {
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : {};
    return body && typeof body === "object" ? { body } : { error: v1Error(400, "Invalid request.") };
  } catch {
    return { error: v1Error(400, "Invalid request.") };
  }
}

/** Authenticates an app request; the device session is the JWT session. */
export async function withV1User(context, label, handler) {
  const supabaseAdmin = adminClient(context.env);
  const { user, claims, response } = await requireUser(context.request, supabaseAdmin);
  if (!user) return v1Json({ message: "Please log in again." }, response?.status ?? 401);
  try {
    return await handler(supabaseAdmin, user, claims?.session_id ?? null);
  } catch (err) {
    console.error(`${label}: unexpected error:`, err.message);
    return v1Error(503, "Arcana is temporarily unavailable.");
  }
}

/** The body shared by login, register and refresh. */
export function sessionBody(session, sessionId) {
  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : new Date(Date.now() + (session.expires_in ?? 3600) * 1000).toISOString();
  return {
    account: { email: session.user?.email },
    device_session_id: sessionId,
    access_token: session.access_token,
    access_expires_at: expiresAt,
    refresh_token: session.refresh_token,
  };
}
