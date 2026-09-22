// Keys that must never reach an admin API response. subscription_url is
// the plaintext VPN credential (see functions/api/agent/jobs/[id]/complete.js,
// where CREATE_USER/ROTATE_SUBSCRIPTION_TOKEN completions carry it in
// `result`). Extend this list if a future job_type's result ever carries
// another secret.
const SENSITIVE_RESULT_KEYS = ["subscription_url"];

/**
 * Returns a copy of a provisioning_jobs.result value with sensitive keys
 * redacted. Every admin route that returns job data (functions/api/admin/jobs.js,
 * functions/api/admin/customers/[id]/index.js) must pass result through
 * this before sending it to the browser.
 */
export function sanitizeJobResult(result) {
  if (!result || typeof result !== "object") return result;
  const clean = { ...result };
  for (const key of SENSITIVE_RESULT_KEYS) {
    if (key in clean) clean[key] = "[redacted]";
  }
  return clean;
}
