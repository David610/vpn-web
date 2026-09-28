/**
 * App-level rate limiting (F-49, remediation item 11), backed by the
 * `check_rate_limit` Postgres RPC (see
 * supabase/migrations/20260930020000_rate_limits.sql). This project's
 * Cloudflare Pages deployment has no KV/D1 binding, so the counter lives in
 * the same Postgres database as everything else, using a fixed-window
 * counter rather than a sliding one -- adequate for abuse throttling, not
 * billing-grade precision.
 *
 * Keying matters more than the limit itself: many real users share a NAT
 * gateway's public IP (campus networks, mobile carriers, offices), so a
 * pure per-IP key on an anonymous endpoint punishes everyone behind that
 * gateway for one abusive user. Prefer a per-credential/per-account key
 * (email being authenticated against, code being guessed, Telegram user id)
 * with a much more generous IP-level check layered on top only as a
 * backstop against distributed attempts against many different accounts
 * from the same source.
 */

/**
 * @param {object} supabaseAdmin a service-role Supabase client
 * @param {string} key identifies the bucket being limited. Callers should
 *   namespace this (e.g. `"login:email:" + email.toLowerCase()`) and hash
 *   or otherwise avoid putting raw secrets in it, since it is stored as
 *   plain text.
 * @param {{ windowSeconds: number, limit: number }} options
 * @returns {Promise<boolean>} true if this call is within the limit and
 *   should proceed; false if the caller is over the limit right now.
 *   Fails OPEN (returns true) on an unexpected database error -- a rate
 *   limiter that itself takes down auth for everyone on a transient DB
 *   blip is a worse outcome than occasionally missing a throttle.
 */
export async function checkRateLimit(supabaseAdmin, key, { windowSeconds, limit }) {
  try {
    const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_bucket_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    if (error) {
      console.error("checkRateLimit: rpc failed:", error.message);
      return true;
    }
    return data !== false;
  } catch (err) {
    console.error("checkRateLimit: unexpected error:", err.message);
    return true;
  }
}

/** A generic 429 response, consistent across every rate-limited route. */
export function rateLimitedResponse(message = "Too many attempts. Please try again later.") {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60" },
  });
}

/**
 * Best-effort caller identifier for the IP-level backstop layer. Cloudflare
 * sets CF-Connecting-IP on every request that reaches Pages Functions;
 * X-Forwarded-For is kept as a fallback for local/dev proxies only and
 * should not be trusted in production ahead of CF-Connecting-IP, since it
 * is trivially spoofable by the client unless a trusted proxy strips it.
 */
export function clientIpKey(request) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  return ip;
}
