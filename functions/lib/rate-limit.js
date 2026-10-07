import { hmacSha256Hex, sha256Hex } from "./crypto.js";

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

const MIN_HASH_KEY_LENGTH = 32;

async function opaqueBucketKey(key, env) {
  const material = `rate-limit-bucket:v1:${key}`;
  const secret = env?.SUBSCRIPTION_TOKEN_HASH_KEY;
  // hmacSha256Hex rejects short keys; a throw here would fail the limiter open.
  return typeof secret === "string" && secret.length >= MIN_HASH_KEY_LENGTH
    ? hmacSha256Hex(material, secret)
    : sha256Hex(material);
}

/**
 * @param {object} supabaseAdmin a service-role Supabase client
 * @param {string} key identifies the bucket being limited. Callers should
 *   namespace this (e.g. `"login:email:" + email.toLowerCase()`). The key is
 *   never stored as given: it is reduced to a keyed hash first, so neither
 *   customer emails nor client IP addresses reach the database.
 * @param {{ windowSeconds: number, limit: number, env?: object }} options
 *   `env.SUBSCRIPTION_TOKEN_HASH_KEY` keys the hash. Without it the key is
 *   still hashed, but unkeyed, which is weaker for low-entropy inputs.
 * @returns {Promise<boolean>} true if this call is within the limit and
 *   should proceed; false if the caller is over the limit right now.
 *   Fails OPEN (returns true) on an unexpected database error -- a rate
 *   limiter that itself takes down auth for everyone on a transient DB
 *   blip is a worse outcome than occasionally missing a throttle.
 */
export async function checkRateLimit(supabaseAdmin, key, { windowSeconds, limit, env }) {
  try {
    const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_bucket_key: await opaqueBucketKey(key, env),
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
