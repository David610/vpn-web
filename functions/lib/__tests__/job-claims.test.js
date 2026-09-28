import { describe, it, expect } from "vitest";
import { validateJobClaim } from "../job-claims.js";

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

describe("validateJobClaim", () => {
  it("returns job_gone for a missing job", () => {
    expect(validateJobClaim(null, {})).toEqual({ ok: false, status: 410, error: "job_gone" });
  });

  it("returns job_cancelled for a cancelled job", () => {
    const result = validateJobClaim({ status: "cancelled" }, {});
    expect(result).toEqual({ ok: false, status: 409, error: "job_cancelled" });
  });

  it("treats done/failed as a terminal, valid duplicate", () => {
    expect(validateJobClaim({ status: "done" }, {})).toEqual({ ok: true, terminal: "done" });
    expect(validateJobClaim({ status: "failed" }, {})).toEqual({ ok: true, terminal: "failed" });
  });

  it("returns stale_claim for a job that is not (or no longer) claimed", () => {
    expect(validateJobClaim({ status: "pending" }, {})).toEqual({ ok: false, status: 409, error: "stale_claim" });
  });

  it("accepts a tokenless report against a claimed job when the token is not required", () => {
    const result = validateJobClaim(
      { status: "claimed", claim_token: "abc", lease_expires_at: future },
      {},
      { requireToken: false }
    );
    expect(result).toEqual({ ok: true, terminal: null });
  });

  it("rejects a tokenless report once requireToken is set", () => {
    const result = validateJobClaim(
      { status: "claimed", claim_token: "abc", lease_expires_at: future },
      {},
      { requireToken: true }
    );
    expect(result).toEqual({ ok: false, status: 409, error: "stale_claim" });
  });

  it("rejects a mismatched claim_token", () => {
    const result = validateJobClaim(
      { status: "claimed", claim_token: "abc", lease_expires_at: future },
      { claim_token: "def" }
    );
    expect(result).toEqual({ ok: false, status: 409, error: "stale_claim" });
  });

  it("rejects a matching claim_token whose lease has expired", () => {
    const result = validateJobClaim(
      { status: "claimed", claim_token: "abc", lease_expires_at: past },
      { claim_token: "abc" }
    );
    expect(result).toEqual({ ok: false, status: 409, error: "stale_claim" });
  });

  it("accepts a matching, current claim_token", () => {
    const result = validateJobClaim(
      { status: "claimed", claim_token: "abc", lease_expires_at: future },
      { claim_token: "abc" }
    );
    expect(result).toEqual({ ok: true, terminal: null });
  });
});
