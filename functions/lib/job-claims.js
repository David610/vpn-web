/**
 * F-09/D-03/C-10: shared claim-token/lease validation for
 * functions/api/agent/jobs/[id]/complete.js and fail.js.
 *
 * Contract (docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md
 * C-10): the claim response now carries a `claim_token` and
 * `lease_expires_at`. A complete/fail report is only accepted while the job
 * is still `claimed`, the token matches, and the lease has not expired --
 * otherwise `409 stale_claim`. This is what makes fleet-tick's reaper
 * (reap_expired_job_claims) safe to run concurrently with an agent that is
 * just slow rather than actually dead: once the reaper re-queues a job, the
 * original agent's late report for the OLD claim is rejected instead of
 * silently overwriting whatever the next claimant does with it.
 *
 * `REQUIRE_CLAIM_TOKEN` is the transitional flag from C-10: while unset (or
 * not "true"), a report with no `claim_token` in the body at all is treated
 * as coming from an agent that predates this contract and is accepted
 * as long as the job is still `claimed` for this node -- once every agent
 * in the fleet has been upgraded, flipping the flag to "true" makes the
 * token mandatory.
 */
export function validateJobClaim(job, body, { requireToken = false } = {}) {
  if (!job) {
    return { ok: false, status: 410, error: "job_gone" };
  }
  if (job.status === "cancelled") {
    return { ok: false, status: 409, error: "job_cancelled" };
  }
  if (job.status === "done" || job.status === "failed") {
    // Terminal states are handled by the caller as an idempotent duplicate
    // report, not as a claim-validation failure.
    return { ok: true, terminal: job.status };
  }
  if (job.status !== "claimed") {
    // e.g. still `pending` -- the reaper already reclaimed this job (or it
    // was never claimed by this caller in the first place).
    return { ok: false, status: 409, error: "stale_claim" };
  }

  const providedToken = typeof body?.claim_token === "string" ? body.claim_token : null;
  if (!providedToken) {
    if (requireToken) {
      return { ok: false, status: 409, error: "stale_claim" };
    }
    // Transitional: no token in the request at all -- accept as a
    // pre-upgrade agent, provided the job is genuinely still claimed
    // (already checked above).
    return { ok: true, terminal: null };
  }
  if (providedToken !== job.claim_token) {
    return { ok: false, status: 409, error: "stale_claim" };
  }
  if (job.lease_expires_at && new Date(job.lease_expires_at).getTime() < Date.now()) {
    return { ok: false, status: 409, error: "stale_claim" };
  }
  return { ok: true, terminal: null };
}
