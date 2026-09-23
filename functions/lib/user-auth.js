/**
 * Bearer-token authentication for customer-facing routes.
 *
 * Normal routes call requireUser(). Sensitive operations call
 * requireRecentUser(), which reads the JWT's signed AMR timestamps through
 * getClaims() rather than trusting a browser timestamp.
 */

const DEFAULT_RECENT_AUTH_SECONDS = 15 * 60;

// Supabase AMR methods that represent a human-controlled authentication or
// account-verification event. Do not use a negative list here: new passive
// session mechanisms must fail closed for sensitive actions until reviewed.
const HUMAN_AUTH_METHODS = new Set([
  "password",
  "otp",
  "totp",
  "oauth",
  "magiclink",
  "sso/saml",
  "recovery",
  "invite",
  "email/signup",
  "email_change",
  "webauthn",
]);

function accessTokenFrom(request) {
  const authHeader = request.headers.get("Authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

function unauthorized(message) {
  return {
    user: null,
    claims: null,
    response: jsonResponse({ error: message }, 401),
  };
}

function userFromClaims(claims) {
  if (!claims?.sub) return null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    role: typeof claims.role === "string" ? claims.role : null,
  };
}

export async function requireUser(request, supabaseAdmin) {
  const accessToken = accessTokenFrom(request);
  if (!accessToken) return unauthorized("Authorization required");

  // getClaims verifies the JWT signature against Supabase's JWKS. With
  // asymmetric signing keys this avoids a network trip to GoTrue on every
  // customer API request; Supabase falls back to server verification for
  // legacy symmetric projects, so the security model does not weaken.
  const { data: claimsData, error } = await supabaseAdmin.auth.getClaims(accessToken);
  const claims = claimsData?.claims;
  const user = userFromClaims(claims);
  if (error || !user) return unauthorized("Invalid or expired token");

  return { user, claims, response: null };
}

/**
 * Requires a real authentication event within maxAgeSeconds.
 *
 * Passive/session AMR methods deliberately do not count: refreshing a
 * long-lived session (or an anonymous session) is not the same thing as the
 * user proving possession of an authentication factor again.
 */
export async function requireRecentUser(
  request,
  supabaseAdmin,
  maxAgeSeconds = DEFAULT_RECENT_AUTH_SECONDS
) {
  const accessToken = accessTokenFrom(request);
  if (!accessToken) return unauthorized("Authorization required");

  const { data: claimsData, error: claimsError } =
    await supabaseAdmin.auth.getClaims(accessToken);
  const claims = claimsData?.claims;
  if (claimsError || !claims?.sub) return unauthorized("Invalid or expired token");

  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  const authTimestamps = amr
    .filter((entry) => entry && HUMAN_AUTH_METHODS.has(entry.method))
    .map((entry) => Number(entry.timestamp))
    .filter(Number.isFinite);

  // If AMR is absent, fail closed for sensitive actions. Falling back to
  // JWT iat would be unsafe because a refreshed access token gets a fresh iat
  // even when the human has not authenticated again.
  const latestAuth = authTimestamps.length ? Math.max(...authTimestamps) : null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(latestAuth) || nowSeconds - latestAuth > maxAgeSeconds) {
    return {
      user: null,
      claims,
      response: jsonResponse(
        {
          error: "Please sign in again before continuing.",
          code: "reauth_required",
        },
        403
      ),
    };
  }

  const user = userFromClaims(claims);
  if (!user) return unauthorized("Invalid or expired token");

  return { user, claims, response: null };
}

export { DEFAULT_RECENT_AUTH_SECONDS };

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
