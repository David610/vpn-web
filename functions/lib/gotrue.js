/**
 * Minimal Supabase Auth (GoTrue) REST calls for the Arcana app's /v1 API.
 *
 * The website signs in with supabase-js in the browser; the app cannot, so
 * the control plane performs the password and refresh grants for it and
 * returns the same Supabase session tokens. Passwords pass through only and
 * are never stored or logged.
 */

export class AuthRejected extends Error {
  constructor(status, code) {
    super(`auth rejected (${status}${code ? `, ${code}` : ""})`);
    this.status = status;
    this.code = code ?? null;
  }
}

async function call(env, path, { body, accessToken } = {}) {
  // These calls hit GoTrue's public-facing endpoints (password/refresh
  // grants, signup, logout) on behalf of arbitrary unauthenticated callers.
  // SUPABASE_ANON_KEY must be present and used here -- it must never fall
  // back to SUPABASE_SERVICE_ROLE_KEY, which would hand a privileged key to
  // whatever GoTrue does with the `apikey` header on a public route. Fail
  // closed instead of silently using the wrong key.
  if (!env.SUPABASE_ANON_KEY) {
    throw new Error("gotrue: SUPABASE_ANON_KEY is not configured");
  }
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status >= 500) throw new Error(`auth service error ${res.status}`);
  if (!res.ok) throw new AuthRejected(res.status, data?.error_code ?? data?.code ?? null);
  return data;
}

/** @returns {Promise<object>} a Supabase session */
export function passwordGrant(env, email, password) {
  return call(env, "/token?grant_type=password", { body: { email, password } });
}

export function refreshGrant(env, refreshToken) {
  return call(env, "/token?grant_type=refresh_token", { body: { refresh_token: refreshToken } });
}

/** Revokes the session behind this access token (this device only). */
export async function signOutSession(env, accessToken) {
  try {
    await call(env, "/logout?scope=local", { accessToken });
  } catch (err) {
    if (!(err instanceof AuthRejected)) throw err;
  }
}

/**
 * Creates an account. Returns the session when the project signs users in
 * immediately, or null when email confirmation is required first.
 */
export async function signUp(env, email, password) {
  const data = await call(env, "/signup", { body: { email, password } });
  return data?.access_token ? data : null;
}

/** The session id (`session_id` claim) inside a Supabase access token. */
export function sessionIdOf(accessToken) {
  try {
    const payload = accessToken.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.session_id === "string" ? json.session_id : null;
  } catch {
    return null;
  }
}
