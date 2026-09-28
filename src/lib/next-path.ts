/**
 * Reads the post-authentication destination from the current URL.
 *
 * An invitee following an invite link has to sign in or sign up first, then
 * come back to the invite — so `?next=` carries that destination through the
 * auth pages.
 *
 * The value is attacker-controlled: anyone can send a victim a link to our
 * own login page with `?next=` pointing at their site, and a redirect after
 * a successful login is exactly the moment a user is most likely to trust
 * whatever appears next. Prefix checks on the raw string are not enough —
 * `URL.parse`/`new URL` (and browsers' own address bars) strip or collapse
 * leading control characters (tabs, newlines) before resolving a scheme, so
 * a string like "/\t/evil.test" is not a same-origin path at all once
 * parsed: it becomes protocol-relative to //evil.test. The only reliable
 * check is to actually resolve the candidate against our own origin with
 * the platform URL parser and then verify what came out the other side:
 *
 *   - resolve `raw` against `location.origin` with `new URL(...)`
 *   - reject if resolution throws (not a URL at all)
 *   - reject unless the resolved origin equals our own origin (catches
 *     absolute URLs, protocol-relative "//evil.test", and control-character
 *     smuggling like "/\t/evil.test" or "/%0a/evil.test" that would
 *     otherwise resolve off-origin)
 *   - reject if the raw string (before parsing) contains any ASCII control
 *     character (0x00–0x1F, 0x7F) or a backslash, since those are exactly
 *     the characters browsers are inconsistent about collapsing before the
 *     parser ever sees them
 *   - reject if the raw string doesn't start with a single "/" (rejects
 *     bare hosts like "evil.test" and scheme-relative forms)
 *   - re-run the same checks after `decodeURIComponent`, so percent-encoded
 *     variants ("%0a", "%09", "%5c", "%2f%2f...") can't slip past the raw
 *     check and only get dangerous once something later decodes them
 *
 * Anything that fails falls back to the default rather than failing loudly:
 * a malformed `next` is not worth blocking a legitimate login over.
 */
export function safeNextPath(search: string, fallback = "/dashboard/"): string {
  const raw = new URLSearchParams(search).get("next");
  if (!raw) return fallback;
  if (!isSafeCandidate(raw)) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (decoded !== raw && !isSafeCandidate(decoded)) return fallback;

  return raw;
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function isSafeCandidate(candidate: string): boolean {
  if (!candidate.startsWith("/")) return false;
  if (candidate.startsWith("//")) return false;
  if (CONTROL_CHAR_RE.test(candidate)) return false;
  if (candidate.includes("\\")) return false;

  const origin = "https://arcana.invalid";
  let resolved: URL;
  try {
    resolved = new URL(candidate, origin);
  } catch {
    return false;
  }
  return resolved.origin === origin;
}
