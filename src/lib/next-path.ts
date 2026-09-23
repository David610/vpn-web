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
 * whatever appears next. So only same-origin *paths* are honoured:
 *
 *   - must start with a single "/" — rejects "https://evil.test"
 *   - must not start with "//" — rejects protocol-relative "//evil.test",
 *     which browsers resolve to an absolute URL
 *   - must not start with "/\" — some browsers treat backslashes as slashes
 *
 * Anything else falls back to the default rather than failing loudly: a
 * malformed `next` is not worth blocking a legitimate login over.
 */
export function safeNextPath(search: string, fallback = "/dashboard/"): string {
  const raw = new URLSearchParams(search).get("next");
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
