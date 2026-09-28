// Keys that must never reach an admin API response. subscription_url and
// provisioning_url are plaintext VPN credentials (see
// functions/api/agent/jobs/[id]/complete.js, where CREATE_USER/
// ROTATE_SUBSCRIPTION_TOKEN completions used to carry them in `result`
// verbatim -- complete.js now writes only an allowlisted, non-secret
// summary to provisioning_jobs.result, but this list stays as
// defense-in-depth against any job_type or code path that puts a
// credential-shaped field into `result` in the future). Extend this list,
// or the pattern below, if a future field ever carries another secret.
const SENSITIVE_RESULT_KEYS = [
  "subscription_url",
  "provisioning_url",
  "preferred_setup_url",
  "setup_url",
  "config_url",
];

// Any key that merely *looks* credential-shaped is redacted too, so a
// typo'd or newly-added field name doesn't silently leak a live URL or
// token to a read-only admin. Read-only admins should only ever see that a
// job carries a credential, never the credential itself; only owners/
// writers with a legitimate operational need reach the actual secret (via
// vpn_secrets, decrypted only on the customer-facing read path in
// functions/api/vpn/config.js).
const SENSITIVE_KEY_PATTERN = /url|token|secret|credential|password|passphrase/i;

/**
 * Returns a copy of a provisioning_jobs.result value with sensitive keys
 * redacted. Every admin route that returns job data (functions/api/admin/jobs.js,
 * functions/api/admin/customers/[id]/index.js) must pass result through
 * this before sending it to the browser.
 */
export function sanitizeJobResult(result) {
  if (!result || typeof result !== "object") return result;
  const clean = { ...result };
  for (const key of Object.keys(clean)) {
    if (SENSITIVE_RESULT_KEYS.includes(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      clean[key] = "[redacted]";
    }
  }
  return clean;
}
