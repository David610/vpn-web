/**
 * Structured JSON logging for Cloudflare Pages Functions.
 *
 * Problem this solves (F-36 / J-02): every handler in this codebase logs
 * with bare `console.error("some string", err.message)`. That is fine for a
 * human tailing a single invocation, but it cannot be queried, correlated
 * across a request, or safely scanned for secret-shaped values before it
 * ships. This module gives every call site three things instead:
 *
 *   1. A request id, generated once per Function invocation and threaded
 *      through every log line for that request (`withRequestId` /
 *      `requestIdFrom`).
 *   2. One JSON object per line (`{ level, msg, request_id, ts, ...fields }`)
 *      so log lines are greppable/queryable in Cloudflare's log tooling.
 *   3. A redaction pass that refuses to print obviously secret-shaped
 *      strings (JWTs, `sk_live_`/`sk_test_` Stripe keys, bearer tokens,
 *      long hex/base64 blobs) even if a caller accidentally hands one to
 *      `fields`.
 *
 * This module does not replace `console.error` calls wholesale across the
 * codebase — that is a large, cross-owner change. It is the shared helper
 * new and touched call sites should adopt; see
 * docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md
 * section 20 and F-36.
 */

const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|auth_header|cookie|credential|subscription_url|private_key|client_secret)/i;

// Value-shape checks: catch secrets even when the field name doesn't hint at
// it (e.g. a variable named `value` holding a bearer token).
const SECRET_VALUE_PATTERNS = [
  /^Bearer\s+\S+/i,
  /^sk_(live|test)_[A-Za-z0-9]+/, // Stripe secret key
  /^whsec_[A-Za-z0-9]+/, // Stripe webhook signing secret
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // long base64 blob
  /^[0-9a-f]{40,}$/i, // long hex blob (raw keys, hashes used as secrets)
];

const REDACTED = "[redacted]";

function looksSecret(key, value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Deep-redacts a plain object/array tree in place semantics (returns a new
 * value; does not mutate the input). Used on every `fields` payload before
 * it is stringified, so a field a caller forgot to scrub does not leak.
 */
export function redact(value, keyHint = "") {
  if (typeof value === "string") {
    return looksSecret(keyHint, value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, keyHint));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = looksSecret(key, typeof val === "string" ? val : "")
        ? REDACTED
        : redact(val, key);
    }
    return out;
  }
  return value;
}

/**
 * Generates a request id. Crypto.randomUUID is available in the Workers
 * runtime; the fallback only matters for local test environments that lack
 * it (older Node without --experimental-global-webcrypto).
 */
export function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reads an inbound request id (set by an upstream proxy or a prior hop) or
 * mints a new one. Call this once at the top of a Function and pass the
 * result to `logger()`/`logEvent()` for the rest of the invocation so every
 * line for one request shares an id.
 */
export function requestIdFrom(request) {
  const inbound = request?.headers?.get?.("cf-ray") || request?.headers?.get?.("x-request-id");
  return inbound || newRequestId();
}

/**
 * Emits one structured JSON log line.
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} msg - short, stable, human-readable event name, e.g.
 *   "stripe_webhook.handler_failed". Do not interpolate variable data into
 *   msg; put it in `fields` so it is both redacted and queryable.
 * @param {object} [fields] - structured context. Anything secret-shaped is
 *   redacted before it is printed.
 */
export function logEvent(level, msg, fields = {}) {
  const line = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...redact(fields),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
  return line;
}

/**
 * Binds a request id (and optional static fields, e.g. { fn: "stripe-webhook" })
 * so call sites don't have to repeat them on every log call.
 *
 * @example
 *   const log = logger(requestIdFrom(request), { fn: "stripe-webhook" });
 *   log.error("handler_failed", { event_type: event.type, error: err.message });
 */
export function logger(requestId, staticFields = {}) {
  const base = { request_id: requestId, ...staticFields };
  const bind = (level) => (msg, fields = {}) => logEvent(level, msg, { ...base, ...fields });
  return {
    requestId,
    debug: bind("debug"),
    info: bind("info"),
    warn: bind("warn"),
    error: bind("error"),
  };
}
