import { createClient } from "@supabase/supabase-js";
import { advanceOperation } from "../../lib/fleet-operations.js";
import { fleetContext, isValidFleetTickSecret } from "../../lib/fleet-context.js";
import { finalizeAccountDeletions } from "../../lib/account-service.js";
import { autoReplaceFailedNodes } from "../../lib/node-auto-replace.js";
import { autoScaleFullLocations } from "../../lib/node-auto-scale.js";
import { failSilentNodes } from "../../lib/node-silence-failover.js";
import { SILENCE_ELIGIBLE_STATES } from "../../lib/node-health-transition.js";
import { raiseAlert } from "../../lib/alerts.js";
import { reconcileFailedNodeAssignments } from "../../lib/fleet-operations.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const BATCH = 10;
// Longer than one tick's worst case (a createInstance call plus probes),
// short enough that a crashed invocation's operations resume next minute.
const LEASE_SECONDS = 120;

/**
 * The fleet reconciler's heartbeat. Called once a minute by Supabase
 * pg_cron (via pg_net, see scripts/setup-fleet-cron.mjs) with the shared
 * FLEET_TICK_SECRET; leases due operations and advances each as far as it
 * can go. Safe to call concurrently or repeatedly -- leasing is atomic and
 * every step is idempotent.
 */
export async function onRequestPost({ env, request }) {
  if (!(await isValidFleetTickSecret(request.headers.get("X-Fleet-Tick-Secret"), env.FLEET_TICK_SECRET))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: ops, error } = await supabaseAdmin.rpc("lease_fleet_operations", {
    p_limit: BATCH,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    console.error("fleet-tick: lease failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }

  const ctx = fleetContext(supabaseAdmin, env);
  const results = [];
  for (const op of ops ?? []) {
    try {
      const result = await advanceOperation(ctx, op);
      results.push({ id: op.id, type: op.type, nodeId: op.node_id, ...result });
    } catch (err) {
      // Infrastructure failure (DB unreachable mid-step): the lease lapses
      // and the next tick retries from the last persisted step.
      console.error("fleet-tick: advance failed:", op.id, err.message);
      results.push({ id: op.id, type: op.type, nodeId: op.node_id, status: "ERROR" });
    }
  }
  // Account deletions complete here, once every VPN identity of the
  // account is confirmed disabled (see account-service.js).
  let deletedAccounts = 0;
  try {
    deletedAccounts = (await finalizeAccountDeletions(supabaseAdmin)).length;
  } catch (err) {
    console.error("fleet-tick: account deletion finalize failed:", err.message);
  }

  // F-20/C-12: silence detection used to be "lazy" -- it only ran as a
  // side effect of some OTHER node's heartbeat (heartbeat.js) or an admin
  // loading the fleet page (admin/nodes.js). A single-node fleet, or every
  // node going dark at once, has no such trigger: nothing else's heartbeat
  // fires, and nobody is watching the admin page. Running the same sweep
  // from fleet-tick means it fires every minute unconditionally.
  let silenceFailed = [];
  if (env.FEATURE_AUTO_NODE_HEALTH === "true") {
    try {
      const { data: candidateNodes, error: candidatesError } = await supabaseAdmin
        .from("nodes")
        .select("node_id, lifecycle_state, last_seen_at")
        .in("lifecycle_state", [...SILENCE_ELIGIBLE_STATES]);
      if (candidatesError) throw new Error(candidatesError.message);
      silenceFailed = await failSilentNodes(supabaseAdmin, candidateNodes ?? [], Date.now());
    } catch (err) {
      console.error("fleet-tick: silence sweep failed:", err.message);
    }
  }

  // F-09/D-03/C-10: reap claimed jobs whose 10-minute lease has expired --
  // the agent that claimed them is presumed dead. Runs every tick
  // unconditionally (no feature flag): unlike auto-replace/auto-scale this
  // has no fleet-shape side effect, only a status flip + attempt counter,
  // so there is no blast-radius reason to gate it.
  let reapedJobs = [];
  try {
    const { data: reaped, error: reapError } = await supabaseAdmin.rpc("reap_expired_job_claims", {
      p_max_attempts: 5,
    });
    if (reapError) throw new Error(reapError.message);
    reapedJobs = reaped ?? [];
    for (const job of reapedJobs) {
      if (job.new_status !== "failed") continue;
      await raiseAlert(supabaseAdmin, {
        kind: "provisioning_job_claim_exhausted",
        severity: "critical",
        dedupKey: `job-claim-exhausted:${job.id}`,
        nodeId: job.node_id,
        message: `Provisioning job #${job.id} (${job.job_type}) exhausted its retry budget (${job.attempts} attempts) after repeated claim-lease expiry`,
      });
    }
  } catch (err) {
    console.error("fleet-tick: job claim reaper failed:", err.message);
  }

  // F-20/B-03/C-12: make-before-break re-placement of legacy devices off
  // FAILED/DRAINING nodes, independent of any explicit REPLACE_NODE
  // operation. See fleet-operations.js#reconcileFailedNodeAssignments.
  let reassignedDevices = [];
  if (env.FEATURE_AUTO_NODE_HEALTH === "true") {
    try {
      reassignedDevices = await reconcileFailedNodeAssignments(supabaseAdmin);
    } catch (err) {
      console.error("fleet-tick: failed-node re-placement failed:", err.message);
    }
  }

  let autoReplaced = [];
  if (env.FEATURE_AUTO_NODE_REPLACE === "true") {
    try {
      autoReplaced = await autoReplaceFailedNodes(supabaseAdmin, env);
    } catch (err) {
      console.error("fleet-tick: auto-replace failed:", err.message);
    }
  }
  let autoScaled = [];
  if (env.FEATURE_AUTO_NODE_SCALE === "true") {
    try {
      autoScaled = await autoScaleFullLocations(supabaseAdmin, env);
    } catch (err) {
      console.error("fleet-tick: auto-scale failed:", err.message);
    }
  }
  return json({
    leased: results.length,
    results,
    deletedAccounts,
    silenceFailed,
    reapedJobs,
    reassignedDevices,
    autoReplaced,
    autoScaled,
  });
}
