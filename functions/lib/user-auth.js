/**
 * Bearer-token authentication for customer-facing routes.
 *
 * Normal routes call requireUser(). Sensitive operations call
 * requireRecentUser(), which reads the JWT's signed AMR timestamps through
 * getClaims() rather than trusting a browser timestamp.
 */

const DEFAULT_RECENT_AUTH_SECONDS = 15 * 60;

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

export async function requireUser(request, supabaseAdmin) {
  const accessToken = accessTokenFrom(request);
  if (!accessToken) return unauthorized("Authorization required");

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !user) return unauthorized("Invalid or expired token");

  return { user, claims: null, response: null };
}

/**
 * Requires a real authentication event within maxAgeSeconds.
 *
 * Token refreshes deliberately do not count: refreshing a long-lived session
 * is not the same thing as the user proving possession of an authentication
 * factor again. Password / OTP / WebAuthn entries in the signed AMR list do.
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
    .filter((entry) => entry && entry.method !== "token_refresh")
    .map((entry) => Number(entry.timestamp))
    .filter(Number.isFinite);

  // Older projects/tokens may not carry AMR. Fall back to iat, which is
  // still a signed claim and is conservative for a newly established
  // session. It is intentionally NOT refreshed client-side here.
  const latestAuth = authTimestamps.length
    ? Math.max(...authTimestamps)
    : Number(claims.iat);

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

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !user || user.id !== claims.sub) {
    return unauthorized("Invalid or expired token");
  }

  return { user, claims, response: null };
}

export { DEFAULT_RECENT_AUTH_SECONDS };

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
