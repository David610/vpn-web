import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "../../lib/user-auth.js";
import { checkRateLimit, rateLimitedResponse, clientIpKey } from "../../lib/rate-limit.js";

/**
 * F-13 (P1): password reset previously had no server-side route at all --
 * the browser called supabase.auth.resetPasswordForEmail() directly, relying
 * only on GoTrue's own (much coarser) throttling, which sees Cloudflare's
 * egress IPs rather than the client (same shape as F-13's login/register/
 * refresh gap, functions/v1/auth/login.js).
 *
 * Public and unauthenticated by design -- the entire point is a customer who
 * is locked out and cannot present a session. Keyed primarily by the email
 * being reset (a customer's own retries near a real reset should not be
 * blocked by unrelated traffic sharing their NAT gateway); a much more
 * generous IP-level backstop catches a single attacker enumerating many
 * different addresses from one source. Same two-layer pattern as
 * functions/v1/auth/login.js and functions/lib/rate-limit.js's own doc
 * comment.
 */
const RESET_WINDOW_SECONDS = 60 * 60;
const RESET_LIMIT_PER_EMAIL = 3;
const RESET_LIMIT_PER_IP = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Never reveal whether an account exists: the same response is returned on
// every outcome the caller can distinguish from -- unknown email, GoTrue
// error, and a genuine send all look identical from the outside.
const GENERIC_RESPONSE = {
  ok: true,
  message: "If an account exists for this email, you will receive a reset link shortly.",
};

export async function onRequestPost({ env, request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const redirectTo = typeof body?.redirectTo === "string" ? body.redirectTo : undefined;

  // A malformed email can never map to a real account, so there is nothing
  // to rate-limit or send -- but the response must stay generic regardless,
  // rather than a 400 that would leak "this input shape is different from a
  // valid reset".
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse(GENERIC_RESPONSE, 200);
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const emailAllowed = await checkRateLimit(supabaseAdmin, `password-reset:email:${email}`, {
    windowSeconds: RESET_WINDOW_SECONDS,
    limit: RESET_LIMIT_PER_EMAIL,
    env,
  });
  const ipAllowed = await checkRateLimit(supabaseAdmin, `password-reset:ip:${clientIpKey(request)}`, {
    windowSeconds: RESET_WINDOW_SECONDS,
    limit: RESET_LIMIT_PER_IP,
    env,
  });
  if (!emailAllowed || !ipAllowed) {
    return rateLimitedResponse("Too many password reset requests. Please try again later.");
  }

  try {
    // resetPasswordForEmail() already does not reveal whether the address
    // has an account (GoTrue returns success either way); this call is
    // still wrapped so an unexpected transport/config error on our side
    // cannot leak through as a different response shape either.
    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      console.error("account/password-reset: resetPasswordForEmail failed:", error.message);
    }
  } catch (err) {
    console.error("account/password-reset: unexpected error:", err.message);
  }

  return jsonResponse(GENERIC_RESPONSE, 200);
}
