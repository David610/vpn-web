/**
 * F-10 (P1): customer-triggerable node-wide disconnects.
 *
 * Every per-user mutation applies through vpn-admin ->
 * render_and_apply_singbox_config -> `systemctl reload-or-restart
 * sing-box` on the node -- ADR-0003 measured that this restart drops every
 * open connection on that node, not just the mutated user's. Any
 * customer-reachable action that enqueues a node-affecting mutation
 * (credential rotation, device add/remove, profile/exit-location
 * reassignment) is therefore a way for one account to disconnect everyone
 * sharing its node, repeatedly, for free.
 *
 * This is a reusable per-account-per-node budget check, built on the same
 * Postgres-backed fixed-window counter as functions/lib/rate-limit.js
 * (check_rate_limit RPC, migration 20260930020000_rate_limits.sql) --
 * no new infrastructure, just a new bucket key shape.
 *
 * Ownership note (see the cross-repo remediation plan's file-ownership
 * table): the actual customer-facing route that most needs this
 * (functions/api/vpn/rotate-credentials.js) is CP-BILL-owned, not touched
 * here. This module only exports the check; wiring it into that route (and
 * into any CP-BILL-owned device add/remove or profile-assignment route) is
 * that file's owner's call to make -- see this track's final report for the
 * exact call shape.
 */

import { checkRateLimit } from "./rate-limit.js";

/**
 * Default budget: at most 10 non-renewal, node-affecting mutations per
 * account per node per rolling hour. "Non-renewal" matters -- a routine
 * SET_EXPIRY/renewal job is not customer-triggered on demand the way a
 * rotate/add/remove/reassign action is, so it must never share this bucket
 * (a customer renewing near several billing-cycle boundaries should never
 * find their genuinely customer-triggered mutations already budget-capped
 * by background renewal traffic that was never the DoS vector in the first
 * place).
 */
export const DEFAULT_NODE_MUTATION_BUDGET = { windowSeconds: 60 * 60, limit: 10 };

/**
 * @param {object} supabaseAdmin service-role Supabase client
 * @param {string} accountId the customer account performing the mutation
 * @param {string} nodeId the node the mutation would apply to
 * @param {{ windowSeconds: number, limit: number }} [budget]
 * @returns {Promise<boolean>} true if this mutation is within budget and
 *   should proceed; false if the account has exhausted its budget for this
 *   node right now (caller should return 429). Fails OPEN on an
 *   unreachable rate-limit backend, same policy as rate-limit.js itself --
 *   a budget check that can itself take down provisioning on a transient
 *   DB blip is a worse outcome than occasionally missing a throttle.
 */
export async function checkNodeMutationBudget(
  supabaseAdmin,
  accountId,
  nodeId,
  budget = DEFAULT_NODE_MUTATION_BUDGET
) {
  const key = `node-mutation:${accountId}:${nodeId}`;
  return checkRateLimit(supabaseAdmin, key, budget);
}
