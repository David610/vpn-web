#!/usr/bin/env node

/**
 * Phase 8 remediation: abandoned-node cleanup (F-audit 2026-09-27, "no
 * cleanup job for abandoned FAILED nodes' servers and DNS records").
 *
 * Finds FAILED nodes stale beyond CLEANUP_FAILED_STALE_MS and RETIRED
 * nodes whose provider instance was never confirmed destroyed, and for
 * each one with zero live device_node_assignments, drives its
 * CLEANUP_ABANDONED_NODE saga (functions/lib/fleet-operations.js) one step:
 * remove DNS, revoke its credential, retire it, destroy its provider
 * instance. A node with any live assignment is never touched destructively,
 * however stale/degraded its health looks -- see VERIFY_ELIGIBLE in
 * fleet-operations.js.
 *
 * This is a normal operator tool, not fleet-tick.js: it is meant to be run
 * by hand (or from its own cron) so an operator can review a dry-run
 * report before ever letting it mutate anything.
 *
 * Required:
 *   SUPABASE_URL=https://...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * Usage:
 *   node scripts/cleanup-abandoned-nodes.mjs --dry-run   (default; read-only)
 *   node scripts/cleanup-abandoned-nodes.mjs --live      (mutates)
 */

import { createClient } from "@supabase/supabase-js";
import { runAbandonedNodeCleanup } from "../functions/lib/fleet-cleanup.js";

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main() {
  const dryRun = !process.argv.includes("--live");

  const supabase = createClient(envOrThrow("SUPABASE_URL"), envOrThrow("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const report = await runAbandonedNodeCleanup(supabase, process.env, { dryRun });

  console.log(`mode: ${dryRun ? "DRY RUN (no mutations)" : "LIVE"}`);
  console.log(`candidates: ${report.length}`);
  for (const entry of report) {
    console.log(
      `- ${entry.nodeId} [${entry.lifecycleState}] eligible=${entry.eligible} liveAssignments=${entry.liveAssignments}: ${entry.reason}`
    );
    if (entry.plannedActions) console.log(`    actions: ${entry.plannedActions.join(", ")}`);
    if (entry.operation) console.log(`    operation: ${JSON.stringify(entry.operation)}`);
  }
  if (dryRun && report.length > 0) {
    console.log("\nRe-run with --live to actually perform the actions listed above.");
  }
}

main().catch((err) => {
  console.error("cleanup-abandoned-nodes: failed:", err.message);
  process.exit(1);
});
