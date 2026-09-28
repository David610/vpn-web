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
 * NOT a migration. NOT wired into any auto-run path. This must be run
 * manually by an operator, against production, only after explicit
 * approval -- see docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md
 * item H-01 and docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md
 * F-04.
 *
 * The actual secret is not lost by running this: it already lives
 * encrypted in vpn_secrets (functions/lib/crypto.js, AES-GCM) and that is
 * the only copy functions/api/vpn/config.js ever reads for customers.
 * This script only removes the redundant plaintext copy that
 * provisioning_jobs.result should never have held.
 *
 * Usage (dry run by default -- prints what WOULD change, writes nothing):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-plaintext-urls.mjs
 *
 * Usage (actually writes, only after --confirm and operator approval):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-plaintext-urls.mjs --confirm
 */
import { createClient } from "@supabase/supabase-js";

const SENSITIVE_KEY_PATTERN = /url|token|secret|credential|password|passphrase/i;

function sanitize(result) {
  if (!result || typeof result !== "object") return { result, changed: false };
  let changed = false;
  const clean = {};
  for (const [key, value] of Object.entries(result)) {
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

async function main() {
  const confirm = process.argv.includes("--confirm");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(confirm ? "Running in WRITE mode (--confirm passed)." : "Running in DRY-RUN mode (pass --confirm to write).");

  const PAGE_SIZE = 500;
  let from = 0;
  let scanned = 0;
  let matched = 0;
  let updated = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from("provisioning_jobs")
      .select("id, result")
      .not("result", "is", null)
      .range(from, from + PAGE_SIZE - 1)
      .order("id", { ascending: true });
    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const { result, changed } = sanitize(row.result);
      if (!changed) continue;
      matched++;
      console.log(`job ${row.id}: would clear fields matching ${SENSITIVE_KEY_PATTERN} from result`);
      if (confirm) {
        const { error: updateError } = await supabase
          .from("provisioning_jobs")
          .update({ result })
          .eq("id", row.id);
        if (updateError) {
          console.error(`job ${row.id}: update failed:`, updateError.message);
          continue;
        }
        updated++;
      }
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`Scanned ${scanned} rows with a non-null result.`);
  console.log(`${matched} rows ${confirm ? "were" : "would be"} affected.`);
  if (confirm) console.log(`${updated} rows updated.`);
  else console.log("No changes written. Re-run with --confirm to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
