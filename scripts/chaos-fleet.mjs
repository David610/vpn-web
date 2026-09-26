#!/usr/bin/env node

/**
 * Fleet chaos-injection tool (Fleet Platform Plan Phase 14). Simulates the
 * exact telemetry conditions Phase 8/12a/12b's automation reacts to --
 * silence, probe-failure streaks -- so a drill exercises the real
 * detection logic (node-health-transition.js, fleet-operations.js's
 * AWAIT_CANARY), not just its downstream effects. The admin lifecycle API
 * (PATCH /api/admin/nodes/:id/lifecycle) cannot do this: it lets an admin
 * force a state directly, which bypasses detection entirely and would only
 * test what happens *after* a verdict already exists.
 *
 * This talks directly to Supabase with the service-role key (same
 * trust level as the Worker itself), because last_seen_at and
 * consecutive_probe_failures are otherwise written only by a real node's
 * own heartbeat -- there is no admin-API path to set them. Treat this
 * tool's credential with the same care as the Worker's own
 * SUPABASE_SERVICE_ROLE_KEY: never run it against production, and never
 * commit a .env file containing it.
 *
 * Required:
 *   SUPABASE_URL=https://...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   CHAOS_TARGET_NODE_ID=de-fsn-001      -- the exact node to target
 *   CHAOS_CONFIRM=de-fsn-001             -- must exactly repeat the node id;
 *                                           a mismatch (typo, wrong env,
 *                                           copy-paste of an old value)
 *                                           refuses to run instead of
 *                                           silently targeting the wrong
 *                                           node
 *
 * Usage:
 *   node scripts/chaos-fleet.mjs <scenario>
 *
 * Scenarios:
 *   silence          Backdate last_seen_at past the silence threshold on a
 *                     READY/DEGRADED/CANARY node. Expect: READY/DEGRADED ->
 *                     FAILED (or CANARY -> FAILED via AWAIT_CANARY) within
 *                     one fleet-tick, without the admin nodes list ever
 *                     being polled for the CANARY case (AWAIT_CANARY runs
 *                     from fleet-tick, not the lazy admin-list check).
 *   probe-failures   Set consecutive_probe_failures to FAILURE_THRESHOLD on
 *                     a READY node with FEATURE_AUTO_NODE_HEALTH on.
 *                     Expect: READY -> DEGRADED on the node's next heartbeat.
 *   canary-abort     Like `silence`, but asserts the node was CANARY before
 *                     and FAILED after, AND that its paired old node (found
 *                     via the owning fleet_operations row's detail.oldNodeId)
 *                     was never touched (still whatever state it was in
 *                     before) -- the specific invariant Phase 12b's design
 *                     called out as the highest-value thing to verify for
 *                     real.
 *   watch            No mutation. Polls and prints the target node's state
 *                     every 5s until Ctrl-C -- use this in a second
 *                     terminal while running a scenario elsewhere, or to
 *                     observe recovery after a real (not simulated)
 *                     failure you've triggered by hand (e.g. `systemctl
 *                     stop vpn-provisioning-agent` over SSH -- the gold-
 *                     standard version of this drill, since it exercises
 *                     the real network path this script's DB writes skip).
 *
 * Every scenario prints the node's state before and after, then polls
 * (POLL_INTERVAL_MS, default 10s) until the expected transition happens or
 * TIMEOUT_MS (default 180s, longer than one fleet-tick cycle) elapses, and
 * exits non-zero on timeout -- a drill that hangs silently forever is a
 * drill nobody trusts.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const targetNodeId = process.env.CHAOS_TARGET_NODE_ID;
const confirm = process.env.CHAOS_CONFIRM;
const pollIntervalMs = Math.max(1000, Number(process.env.POLL_INTERVAL_MS ?? 10_000));
const timeoutMs = Math.max(10_000, Number(process.env.TIMEOUT_MS ?? 180_000));

const scenario = process.argv[2];
const SCENARIOS = new Set(["silence", "probe-failures", "canary-abort", "watch"]);

if (!url || !serviceRoleKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
if (!scenario || !SCENARIOS.has(scenario)) {
  console.error(`Usage: node scripts/chaos-fleet.mjs <${[...SCENARIOS].join("|")}>`);
  process.exit(2);
}
if (!targetNodeId) {
  console.error("Set CHAOS_TARGET_NODE_ID to the exact node id to target.");
  process.exit(2);
}
if (confirm !== targetNodeId) {
  console.error(
    `Set CHAOS_CONFIRM to exactly "${targetNodeId}" (must match CHAOS_TARGET_NODE_ID) to confirm you mean to inject a fault into this specific, real node.`
  );
  process.exit(2);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Mirrors node-health-transition.js's real constants -- kept in sync by
// hand (this script deliberately has zero import dependency on the
// functions/ Worker code, since it's invoked with node, not wrangler).
const HEARTBEAT_INTERVAL_MS = 60_000;
const SILENCE_THRESHOLD_MULTIPLIER = 3;
const FAILURE_THRESHOLD = 3;

async function loadNode(nodeId) {
  const { data, error } = await supabase
    .from("nodes")
    .select("node_id, lifecycle_state, last_seen_at, consecutive_probe_failures, consecutive_probe_successes")
    .eq("node_id", nodeId)
    .maybeSingle();
  if (error) throw new Error(`nodes lookup failed: ${error.message}`);
  if (!data) throw new Error(`node ${nodeId} not found`);
  return data;
}

async function findPairedOldNodeId(newNodeId) {
  const { data, error } = await supabase
    .from("fleet_operations")
    .select("detail")
    .eq("node_id", newNodeId)
    .eq("type", "REPLACE_NODE")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fleet_operations lookup failed: ${error.message}`);
  return data?.detail?.oldNodeId ?? null;
}

async function pollUntil(label, check) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = await loadNode(targetNodeId);
    console.log(
      `[poll] ${targetNodeId}: lifecycle_state=${node.lifecycle_state} consecutive_probe_failures=${node.consecutive_probe_failures}`
    );
    if (check(node)) {
      console.log(`PASS: ${label}`);
      return node;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  console.error(`FAIL (timeout after ${timeoutMs}ms): ${label}`);
  process.exit(1);
}

if (scenario === "watch") {
  console.log(`Watching ${targetNodeId} (Ctrl-C to stop)...`);
  for (;;) {
    const node = await loadNode(targetNodeId);
    console.log(
      `${new Date().toISOString()} ${targetNodeId}: lifecycle_state=${node.lifecycle_state} last_seen_at=${node.last_seen_at} consecutive_probe_failures=${node.consecutive_probe_failures}`
    );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

if (scenario === "silence" || scenario === "canary-abort") {
  const before = await loadNode(targetNodeId);
  console.log(`Before: ${JSON.stringify(before)}`);
  if (scenario === "canary-abort" && before.lifecycle_state !== "CANARY") {
    console.error(`canary-abort requires the target node to currently be CANARY (it is ${before.lifecycle_state}).`);
    process.exit(2);
  }

  const oldNodeId = scenario === "canary-abort" ? await findPairedOldNodeId(targetNodeId) : null;
  if (scenario === "canary-abort" && !oldNodeId) {
    console.error(`Could not find a REPLACE_NODE operation's paired old node for ${targetNodeId}.`);
    process.exit(2);
  }
  const oldNodeBefore = oldNodeId ? await loadNode(oldNodeId) : null;
  if (oldNodeBefore) console.log(`Paired old node before: ${JSON.stringify(oldNodeBefore)}`);

  const staleTimestamp = new Date(
    Date.now() - HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER - 60_000
  ).toISOString();
  const { error } = await supabase
    .from("nodes")
    .update({ last_seen_at: staleTimestamp })
    .eq("node_id", targetNodeId);
  if (error) throw new Error(`nodes update failed: ${error.message}`);
  console.log(`Backdated last_seen_at to ${staleTimestamp}. Waiting for automated FAILED transition...`);

  await pollUntil(`${targetNodeId} transitioned to FAILED after simulated silence`, (node) => node.lifecycle_state === "FAILED");

  if (oldNodeId) {
    const oldNodeAfter = await loadNode(oldNodeId);
    console.log(`Paired old node after: ${JSON.stringify(oldNodeAfter)}`);
    if (oldNodeAfter.lifecycle_state !== oldNodeBefore.lifecycle_state) {
      console.error(
        `FAIL: paired old node ${oldNodeId} changed state (${oldNodeBefore.lifecycle_state} -> ${oldNodeAfter.lifecycle_state}) -- it must stay untouched until the new node is proven, not merely CANARY.`
      );
      process.exit(1);
    }
    console.log(`PASS: paired old node ${oldNodeId} was never touched (still ${oldNodeAfter.lifecycle_state}).`);
  }
}

if (scenario === "probe-failures") {
  const before = await loadNode(targetNodeId);
  console.log(`Before: ${JSON.stringify(before)}`);
  if (before.lifecycle_state !== "READY") {
    console.error(`probe-failures requires the target node to currently be READY (it is ${before.lifecycle_state}).`);
    process.exit(2);
  }

  const { error } = await supabase
    .from("nodes")
    .update({ consecutive_probe_failures: FAILURE_THRESHOLD })
    .eq("node_id", targetNodeId);
  if (error) throw new Error(`nodes update failed: ${error.message}`);
  console.log(`Set consecutive_probe_failures=${FAILURE_THRESHOLD}. Waiting for the node's next heartbeat to degrade it...`);

  await pollUntil(`${targetNodeId} transitioned to DEGRADED after simulated probe failures`, (node) => node.lifecycle_state === "DEGRADED");
}
