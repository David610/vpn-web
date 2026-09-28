/**
 * Bearer-token authentication for customer-facing routes.
 *
 * Normal routes call requireUser(). Sensitive operations call
 * requireRecentUser(), which reads the JWT's signed AMR timestamps through
 * getClaims() rather than trusting a browser timestamp.
 */

// F-43 (per-request GoTrue round trip): supabase-js's getClaims() verifies
// locally against the project's JWKS when the signing key is asymmetric
// (ES256/RS256), and only falls back to a network call to GoTrue's
// getUser() when the key is symmetric (HS256) — because a shared HS256
// secret is not something a client-side JWKS can safely expose. The current
// project's anon key is confirmed HS256 (audit section 22); whether user
// access tokens are also HS256 is not verified but assumed likely, in which
// case every requireUser()/requireRecentUser() call costs one extra
// synchronous round trip to Supabase Auth.
//
// This file cannot remove that round trip on its own: doing so without the
// hosted project's config change would mean re-implementing JWT HMAC
// verification here with the shared SUPABASE_JWT_SECRET, which duplicates
// security-sensitive logic (exp/aud/iss/nbf checks, key rotation handling)
// that supabase-js already owns, for a request path that also decides
// account access. That trade is not worth making without dedicated review
// and tests, so it is deliberately left alone here.
//
// REQUIRES PRODUCTION ACCESS: the real fix is moving the hosted Supabase
// project from a legacy shared JWT secret to asymmetric JWT signing keys
// (Supabase dashboard: Project Settings -> API -> JWT Keys -> "Migrate to
// asymmetric keys", or `supabase projects api-keys` for the CLI-driven
// path). Once user access tokens are signed with an asymmetric key,
// getClaims() verifies them locally against the JWKS with no code change
// needed here, and the per-request GoTrue round trip disappears.
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
