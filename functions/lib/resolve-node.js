/**
 * Single choke point for "which node does this user's VPN account live
 * on". Every call site that used to write the literal "node-1" now goes
 * through here — functions/lib/stripe-events.js and every admin
 * mutation route in this plan — so a second node later is a change in
 * this one function (once real routing logic exists: health, region,
 * capacity), not a grep-and-replace across the codebase. Deliberately
 * NOT parameterized by user/region yet — that logic does not exist, and
 * adding an unused parameter now would be speculative.
 *
 * functions/lib/scheduler.js (spec 54 Phase 5) now has real multi-node
 * placement logic, but nothing here calls into it yet: none of this
 * function's ~7 call sites have been migrated. This stays the fallback
 * every one of them uses until a later phase does that migration, one
 * call site at a time.
 */
export function resolveNodeForUser() {
  return "node-1";
}
