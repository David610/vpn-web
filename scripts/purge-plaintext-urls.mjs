#!/usr/bin/env node
/**
 * One-off, manually-run purge for F-04 / H-01: strips plaintext
 * subscription_url / provisioning_url (and any other URL/token/secret-
 * shaped field) that older provisioning_jobs.result rows carry from before
 * functions/api/agent/jobs/[id]/complete.js was fixed to allowlist what it
 * writes there. New completions can no longer write these fields (see
 * complete.js's sanitizeStoredResult()); this script only cleans up rows
 * written before that fix shipped.
 *
 * NOT a migration. NOT wired into any auto-run path, and NOT to be run
 * against production by an agent -- this must be run manually by an
 * operator, against production, only after explicit approval -- see
 * docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md item H-01
 * and docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md
 * F-04.
 *
 * The actual secret is not lost by running this: it already lives
 * encrypted in vpn_secrets (functions/lib/crypto.js, AES-GCM) and that is
 * the only copy functions/api/vpn/config.js ever reads for customers.
 * This script only removes the redundant plaintext copy that
 * provisioning_jobs.result should never have held.
 *
 * Safety properties (Phase 12):
 *  - dry-run by default. Nothing is ever written unless --live is passed
 *    explicitly. (--confirm is accepted as a deprecated alias for --live.)
 *  - counts-only output: reports row counts and an age-bucket histogram of
 *    affected rows, grouped by table -- never the actual field values, URLs
 *    or tokens themselves, in either mode.
 *  - bounded batches (PAGE_SIZE rows per query/update), so this never holds
 *    a table-wide lock or a single giant transaction.
 *  - resume-safe: progress is a plain `id` cursor printed after every
 *    batch ("resume with --after-id=<id>"), and each row's sanitize step is
 *    idempotent (running it twice on an already-clean row is a no-op), so a
 *    crash mid-run loses no correctness -- restarting from 0 or from the
 *    printed cursor both converge to the same end state.
 *  - post-clean verification: after a --live run, re-scans and asserts zero
 *    rows still match the sensitive-key pattern, exiting non-zero if any
 *    remain (this can legitimately happen if new rows were written by live
 *    traffic during the run -- the summary says so rather than silently
 *    passing).
 *
 * Usage (dry run -- default, writes nothing):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-plaintext-urls.mjs
 *
 * Usage (actually writes, only after operator approval):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-plaintext-urls.mjs --live
 *
 * Usage (resume a --live run from a known-good cursor after a crash):
 *   ... node scripts/purge-plaintext-urls.mjs --live --after-id=1234
 */
import { createClient } from "@supabase/supabase-js";

const SENSITIVE_KEY_PATTERN = /url|token|secret|credential|password|passphrase/i;
const PAGE_SIZE = 500;

// Age buckets for the histogram, in days-since-created_at, ascending.
const AGE_BUCKETS_DAYS = [1, 7, 30, 90, 365];

function bucketLabel(ageDays) {
  for (const b of AGE_BUCKETS_DAYS) {
    if (ageDays <= b) return `<= ${b}d`;
  }
  return `> ${AGE_BUCKETS_DAYS[AGE_BUCKETS_DAYS.length - 1]}d`;
}

export function sanitize(result) {
  if (!result || typeof result !== "object") return { result, changed: false };
  let changed = false;
  const clean = {};
  for (const [key, value] of Object.entries(result)) {
    // `*_reported` is this function's own idempotency marker (see below) --
    // it is a boolean, never a secret, and must not be re-matched by the
    // sensitive-key pattern (it contains "url") on a second pass, or every
    // already-cleaned row would look "changed" forever and verification
    // could never converge to zero.
    if (key.endsWith("_reported")) {
      clean[key] = value;
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      changed = true;
      if (key === "subscription_url" || key === "provisioning_url") {
        clean[`${key}_reported`] = true;
      }
      // Any other URL/token-shaped field is dropped outright rather than
      // guessing at a safe replacement name for it.
      continue;
    }
    clean[key] = value;
  }
  return { result: clean, changed };
}

function parseArgs(argv) {
  const live = argv.includes("--live") || argv.includes("--confirm");
  const dryRunFlag = argv.find((a) => a === "--dry-run" || a.startsWith("--dry-run="));
  // --dry-run=false is rejected: dry-run is the safe default and is only
  // ever turned off via --live, never via a --dry-run value.
  if (dryRunFlag && dryRunFlag !== "--dry-run") {
    console.error("--dry-run takes no value; pass --live to write instead.");
    process.exit(1);
  }
  const afterIdArg = argv.find((a) => a.startsWith("--after-id="));
  const afterId = afterIdArg ? Number(afterIdArg.split("=")[1]) : 0;
  if (afterIdArg && !Number.isFinite(afterId)) {
    console.error("--after-id must be numeric");
    process.exit(1);
  }
  return { live, afterId };
}

/**
 * Scans provisioning_jobs.result in id order starting after `afterId`,
 * calling `onRow(row, sanitized)` for every row whose result contains a
 * sensitive-shaped key. Returns summary counters. Never applies changes --
 * that is the caller's job via `onRow` (or nothing, in dry-run/verify mode).
 */
export async function scan(supabase, { afterId, onMatch }) {
  let cursor = afterId;
  let scanned = 0;
  let matched = 0;
  const ageBuckets = new Map();
  const now = Date.now();

  for (;;) {
    const { data: rows, error } = await supabase
      .from("provisioning_jobs")
      .select("id, result, created_at")
      .not("result", "is", null)
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const { result, changed } = sanitize(row.result);
      if (changed) {
        matched++;
        const ageDays = row.created_at ? (now - new Date(row.created_at).getTime()) / 86400000 : Infinity;
        const label = bucketLabel(ageDays);
        ageBuckets.set(label, (ageBuckets.get(label) ?? 0) + 1);
        if (onMatch) await onMatch(row, result);
      }
      cursor = row.id;
    }

    console.log(`... scanned through id=${cursor} (${scanned} rows so far, ${matched} matched so far)`);
    if (rows.length < PAGE_SIZE) break;
  }

  return { scanned, matched, ageBuckets, lastId: cursor };
}

function printAgeHistogram(ageBuckets) {
  if (ageBuckets.size === 0) {
    console.log("  (no affected rows)");
    return;
  }
  for (const [label, count] of [...ageBuckets.entries()].sort()) {
    console.log(`  age ${label.padEnd(8)} : ${count} row(s)`);
  }
}

async function main() {
  const { live, afterId } = parseArgs(process.argv.slice(2));
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(live ? "Running in LIVE mode (--live passed): rows WILL be updated." : "Running in DRY-RUN mode (default). Pass --live to write. No secret contents are ever printed.");
  if (afterId) console.log(`Resuming after id=${afterId}.`);

  let updated = 0;
  const { scanned, matched, ageBuckets, lastId } = await scan(supabase, {
    afterId,
    onMatch: live
      ? async (row, cleanResult) => {
          const { error: updateError } = await supabase
            .from("provisioning_jobs")
            .update({ result: cleanResult })
            .eq("id", row.id);
          if (updateError) {
            console.error(`job ${row.id}: update failed:`, updateError.message);
            return;
          }
          updated++;
        }
      : null,
  });

  console.log("");
  console.log(`Scanned ${scanned} rows with a non-null result (table: provisioning_jobs, field: result).`);
  console.log(`${matched} rows ${live ? "were" : "would be"} affected.`);
  console.log("Age distribution of affected rows (by created_at):");
  printAgeHistogram(ageBuckets);
  if (live) {
    console.log(`${updated} rows updated.`);
    console.log(`Resume cursor if interrupted: --after-id=${lastId}`);
  } else {
    console.log("No changes written. Re-run with --live to apply.");
    return;
  }

  console.log("");
  console.log("Verifying: re-scanning for any remaining sensitive-key matches...");
  const verify = await scan(supabase, { afterId: 0, onMatch: null });
  if (verify.matched === 0) {
    console.log(`Verification passed: 0 rows remain with sensitive-shaped fields (out of ${verify.scanned} scanned).`);
  } else {
    console.error(
      `Verification FAILED: ${verify.matched} row(s) out of ${verify.scanned} still match the sensitive-key pattern. ` +
        `This can happen if new provisioning_jobs rows were written during the run -- re-run this script (it is idempotent and resumable) to clean them up.`
    );
    process.exitCode = 1;
  }
}

// Only run as a CLI when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
