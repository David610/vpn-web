import {
  findAbandonedNodeCandidates,
  startCleanupAbandonedNodeOperation,
  advanceOperation,
  CLEANUP_ABANDONED_NODE_STEPS,
} from "./fleet-operations.js";
import { fleetContext } from "./fleet-context.js";

/**
 * Phase 8 remediation: the abandoned-node cleanup sweep (F-audit
 * 2026-09-27's "no cleanup job for abandoned FAILED nodes" finding).
 *
 * The actual work -- DNS removal, credential revocation, provider-instance
 * destruction -- is the CLEANUP_ABANDONED_NODE fleet_operations saga in
 * fleet-operations.js (idempotent, resumable, ordered so a live
 * device_node_assignments row blocks every later destructive step). This
 * module is the entry point that finds eligible nodes and either reports
 * on them (dry run) or drives their saga forward (live), and is what both
 * functions/api/internal/fleet-tick.js and scripts/cleanup-abandoned-
 * nodes.mjs call.
 *
 * Dry run makes ZERO writes: it never calls startCleanupAbandonedNodeOperation
 * (which itself would create/return a fleet_operations row) nor
 * advanceOperation -- both are skipped entirely in that branch below.
 */

async function countLiveAssignments(supabase, nodeId) {
  const { data, error } = await supabase.from("device_node_assignments").select("device_id").eq("node_id", nodeId);
  if (error) throw new Error(`device_node_assignments lookup failed: ${error.message}`);
  return (data ?? []).length;
}

/**
 * @param {object} supabase service-role client
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] true (the default) makes no mutations at
 *   all and only reports; false drives each eligible node's cleanup saga
 *   one step forward.
 * @param {number} [opts.now]
 * @param {(name: string, env: object) => object} [opts.providers]
 * @param {(env: object) => object} [opts.dns]
 * @returns {Promise<Array<{
 *   nodeId: string,
 *   lifecycleState: string,
 *   eligible: boolean,
 *   reason: string,
 *   liveAssignments: number,
 *   plannedActions?: string[],
 *   operation?: { status: string, step?: string },
 * }>>}
 */
export async function runAbandonedNodeCleanup(supabase, env, opts = {}) {
  const { dryRun = true, now = Date.now(), providers, dns } = opts;
  const candidates = await findAbandonedNodeCandidates(supabase, { now });

  const report = [];
  for (const node of candidates) {
    const liveAssignments = await countLiveAssignments(supabase, node.node_id);
    const entry = {
      nodeId: node.node_id,
      lifecycleState: node.lifecycle_state,
      liveAssignments,
    };

    if (liveAssignments > 0) {
      report.push({
        ...entry,
        eligible: false,
        reason: `has ${liveAssignments} live device assignment(s), skipped`,
      });
      continue;
    }

    const plannedActions = [];
    if (!node.provider_instance_destroyed_at) plannedActions.push("dns_removal", "credential_revocation");
    plannedActions.push(node.provider_instance_id ? "provider_instance_destroy" : "no_provider_instance_to_destroy");

    if (dryRun) {
      report.push({
        ...entry,
        eligible: true,
        reason: "zero live assignments; would run cleanup saga",
        plannedActions,
      });
      continue;
    }

    const { operation, error } = await startCleanupAbandonedNodeOperation(supabase, { nodeId: node.node_id });
    if (error) {
      report.push({ ...entry, eligible: true, reason: `failed to register cleanup operation: ${error.message}` });
      continue;
    }

    const base = fleetContext(supabase, env);
    const ctx = { ...base, ...(providers ? { providers } : {}), ...(dns ? { dns } : {}) };
    let outcome;
    try {
      outcome = await advanceOperation(ctx, operation);
    } catch (err) {
      report.push({
        ...entry,
        eligible: true,
        reason: `advanceOperation threw: ${err.message}`,
        operation: { status: "ERROR" },
      });
      continue;
    }
    report.push({
      ...entry,
      eligible: true,
      reason: "cleanup saga advanced",
      plannedActions,
      operation: { status: outcome.status, step: outcome.step },
    });
  }
  return report;
}

export { CLEANUP_ABANDONED_NODE_STEPS };
