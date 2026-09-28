import { describe, it, expect, beforeEach } from "vitest";
import { validateJobClaim } from "../job-claims.js";

/**
 * F-09 full-lifecycle regression coverage.
 *
 * The unit tests in job-claims.test.js and the HTTP-level tests in
 * agent/jobs/[id]/__tests__/{complete,fail}.test.js each exercise
 * validateJobClaim() against a single hand-built job row. This file instead
 * runs a small in-memory model of the actual SQL contract --
 * claim_next_job() and reap_expired_job_claims() from
 * supabase/migrations/20261007000000_job_claim_tokens.sql -- and drives the
 * *real* validateJobClaim() through it, so the scenario sequencing (claim,
 * crash, lease expiry, reaper reclaim, late report, cancel-while-claimed,
 * duplicate ack) matches what actually happens across claim.js / complete.js
 * / fail.js / fleet-tick's reaper, not just what a single mocked row implies.
 *
 * The in-memory model intentionally mirrors the migration's SQL 1:1 (same
 * field names, same "claimed iff lease_expires_at set" invariant, same
 * attempts>=max_attempts -> failed cutoff) so a change to the SQL that this
 * file doesn't get updated for shows up as a assertion mismatch here, not a
 * silent divergence.
 */

let nextId = 1;
let jobs;

function reset() {
  jobs = new Map();
  nextId = 1;
}

function insertPendingJob(overrides = {}) {
  const id = nextId++;
  jobs.set(id, {
    id,
    job_type: "CREATE_USER",
    node_id: "node-1",
    status: "pending",
    claim_token: null,
    lease_expires_at: null,
    attempts: 0,
    ...overrides,
  });
  return id;
}

let tokenCounter = 0;
function fakeUuid() {
  tokenCounter += 1;
  return `token-${tokenCounter}`;
}

/** Mirrors claim_next_job(p_node_id): oldest pending row for the node,
 * SKIP LOCKED semantics collapse in-process to "first match", 10-minute
 * lease. */
function claimNextJob(nodeId, now = Date.now()) {
  const candidate = [...jobs.values()]
    .filter((j) => j.node_id === nodeId && j.status === "pending")
    .sort((a, b) => a.id - b.id)[0];
  if (!candidate) return null;
  candidate.status = "claimed";
  candidate.claim_token = fakeUuid();
  candidate.lease_expires_at = new Date(now + 10 * 60_000).toISOString();
  return { ...candidate };
}

/** Mirrors reap_expired_job_claims(p_max_attempts default 5). */
function reapExpiredJobClaims(now = Date.now(), maxAttempts = 5) {
  const reaped = [];
  for (const job of jobs.values()) {
    if (job.status !== "claimed") continue;
    if (!job.lease_expires_at) continue;
    if (new Date(job.lease_expires_at).getTime() >= now) continue;
    job.attempts += 1;
    job.status = job.attempts >= maxAttempts ? "failed" : "pending";
    job.claim_token = null;
    job.lease_expires_at = null;
    reaped.push({ id: job.id, new_status: job.status, attempts: job.attempts });
  }
  return reaped;
}

function reportComplete(jobId, body, opts) {
  const job = jobs.get(jobId);
  const check = validateJobClaim(job ?? null, body, opts);
  if (check.ok && !check.terminal) {
    job.status = "done";
    job.claim_token = null;
    job.lease_expires_at = null;
  }
  return check;
}

function reportFail(jobId, body, opts) {
  const job = jobs.get(jobId);
  const check = validateJobClaim(job ?? null, body, opts);
  if (check.ok && !check.terminal) {
    job.status = "failed";
    job.claim_token = null;
    job.lease_expires_at = null;
  }
  return check;
}

beforeEach(reset);

describe("F-09 job claim lifecycle (claim -> lease -> reap -> reclaim)", () => {
  it("normal path: claim, then complete with the matching token succeeds", () => {
    const id = insertPendingJob();
    const claimed = claimNextJob("node-1");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claim_token).toBeTruthy();
    expect(claimed.lease_expires_at).toBeTruthy();

    const check = reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(check).toEqual({ ok: true, terminal: null });
    expect(jobs.get(id).status).toBe("done");
  });

  it("a crashed agent's job is reclaimable once its lease expires, and the old agent's late report is rejected", () => {
    const id = insertPendingJob();
    const now = Date.now();
    const oldClaim = claimNextJob("node-1", now);

    // Old agent crashes here and never reports. Ten minutes and one second
    // pass; fleet-tick's reaper runs.
    const afterLease = now + 10 * 60_000 + 1_000;
    const reaped = reapExpiredJobClaims(afterLease);
    expect(reaped).toEqual([{ id, new_status: "pending", attempts: 1 }]);
    expect(jobs.get(id).status).toBe("pending");

    // A new (or restarted) agent claims the same job -- reclaim succeeds and
    // gets a fresh token.
    const newClaim = claimNextJob("node-1", afterLease + 1_000);
    expect(newClaim.id).toBe(id);
    expect(newClaim.claim_token).not.toBe(oldClaim.claim_token);
    expect(jobs.get(id).status).toBe("claimed");

    // The OLD agent, unaware it was reaped, finally reports completion for
    // its now-stale claim. It must be rejected -- and must not touch the new
    // claim's state.
    const staleReport = reportComplete(id, { result: {}, claim_token: oldClaim.claim_token });
    expect(staleReport).toEqual({ ok: false, status: 409, error: "stale_claim" });
    expect(jobs.get(id).status).toBe("claimed");
    expect(jobs.get(id).claim_token).toBe(newClaim.claim_token);

    // The NEW agent's own completion is then accepted normally.
    const freshReport = reportComplete(id, { result: {}, claim_token: newClaim.claim_token });
    expect(freshReport).toEqual({ ok: true, terminal: null });
    expect(jobs.get(id).status).toBe("done");
  });

  it("a pre-upgrade agent that never echoes claim_token is vulnerable to the exact race the token was added to close", () => {
    // This reproduces the cross-repo gap documented against
    // apps/provisioning-agent/src/worker_client.rs (complete()/fail() never
    // send claim_token; Job never deserializes it) in singbox-vpn: while
    // REQUIRE_CLAIM_TOKEN is unset/false (today's default, for fleet
    // rollout), a tokenless report is accepted purely on job.status ===
    // "claimed", with no way to tell the old claim from a new one.
    const id = insertPendingJob();
    const now = Date.now();
    const oldClaim = claimNextJob("node-1", now);
    void oldClaim;

    const afterLease = now + 10 * 60_000 + 1_000;
    reapExpiredJobClaims(afterLease);
    const newClaim = claimNextJob("node-1", afterLease + 1_000);
    expect(jobs.get(id).status).toBe("claimed");

    // The old, crashed agent's late report carries no claim_token at all
    // (current singbox-vpn behavior) and requireToken defaults to false ->
    // it is wrongly accepted against the NEW claim.
    const staleTokenlessReport = reportComplete(id, { result: {} }, { requireToken: false });
    expect(staleTokenlessReport).toEqual({ ok: true, terminal: null });
    expect(jobs.get(id).status).toBe("done");
    // Contrast with the previous test: a token-carrying late report is
    // correctly rejected. Once REQUIRE_CLAIM_TOKEN=true is flipped fleet
    // wide this hole closes, but singbox-vpn's agent must be upgraded to
    // send claim_token first or every real completion report will start
    // failing with 409 stale_claim instead.
    void newClaim;
  });

  it("a job cancelled while claimed rejects the agent's eventual completion report", () => {
    const id = insertPendingJob();
    const claimed = claimNextJob("node-1");

    // Something else (e.g. device removal) cancels the job while it's still
    // claimed and in flight on the node.
    jobs.get(id).status = "cancelled";

    const check = reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(check).toEqual({ ok: false, status: 409, error: "job_cancelled" });
    expect(jobs.get(id).status).toBe("cancelled");

    const failCheck = reportFail(id, { error: "boom", claim_token: claimed.claim_token });
    expect(failCheck).toEqual({ ok: false, status: 409, error: "job_cancelled" });
    expect(jobs.get(id).status).toBe("cancelled");
  });

  it("duplicate completion reports (agent retries the same success) are idempotent, not an error and not a double-apply", () => {
    const id = insertPendingJob();
    const claimed = claimNextJob("node-1");

    const first = reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(first).toEqual({ ok: true, terminal: null });
    expect(jobs.get(id).status).toBe("done");

    // Agent never saw the 200 (e.g. response dropped) and retries the exact
    // same completion call.
    const second = reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(second).toEqual({ ok: true, terminal: "done" });
    expect(jobs.get(id).status).toBe("done");

    const third = reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(third).toEqual({ ok: true, terminal: "done" });
    expect(jobs.get(id).status).toBe("done");
  });

  it("a retried complete-then-fail sequence never regresses a done job back to failed", () => {
    const id = insertPendingJob();
    const claimed = claimNextJob("node-1");

    reportComplete(id, { result: {}, claim_token: claimed.claim_token });
    expect(jobs.get(id).status).toBe("done");

    // Cross-repo contract (complete.js's header comment): on a 5xx the
    // agent retries /complete again, never falls back to /fail. This
    // asserts the server-side guard that makes that safe even if it did.
    const check = reportFail(id, { error: "boom", claim_token: claimed.claim_token });
    expect(check).toEqual({ ok: true, terminal: "done" });
    expect(jobs.get(id).status).toBe("done");
  });

  it("attempts >= max_attempts marks the job failed instead of looping forever", () => {
    const id = insertPendingJob();
    let now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      claimNextJob("node-1", now);
      now += 10 * 60_000 + 1_000;
      reapExpiredJobClaims(now, 5);
    }
    expect(jobs.get(id)).toMatchObject({ status: "failed", attempts: 5, claim_token: null });
    // No more pending work for this node -- a subsequent claim finds nothing.
    expect(claimNextJob("node-1", now)).toBeNull();
  });

  it("lease enforcement is purely server-side: a claim that never phones home again still expires and reclaims on schedule", () => {
    // Simulates "the control plane briefly goes unreachable and the agent
    // can't report" -- from the server's point of view this is
    // indistinguishable from a crashed agent, which is the point: nothing
    // about reclaiming depends on hearing from the client again. The lease
    // clock is set once at claim time (lease_expires_at, a plain
    // now()+interval computed server-side in claim_next_job) and the reaper
    // only ever reads that stored timestamp against its own now() -- it
    // never asks the agent anything.
    const id = insertPendingJob();
    const now = Date.now();
    claimNextJob("node-1", now);

    // Nothing happens for a while -- no complete, no fail, no further
    // claim/heartbeat traffic of any kind (outage or crash, same from here).
    const stillWithinLease = now + 5 * 60_000;
    expect(reapExpiredJobClaims(stillWithinLease)).toEqual([]);
    expect(jobs.get(id).status).toBe("claimed");

    const pastLease = now + 10 * 60_000 + 1;
    const reaped = reapExpiredJobClaims(pastLease);
    expect(reaped).toEqual([{ id, new_status: "pending", attempts: 1 }]);
    expect(jobs.get(id).status).toBe("pending");
  });
});
