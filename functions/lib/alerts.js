/**
 * Shared `operational_alerts` writer.
 *
 * Several call sites (agent/heartbeat.js, node-silence-failover.js) already
 * hand-roll the same insert/resolve-by-dedup-key pattern against
 * `operational_alerts`. This module is the one place that pattern should
 * live going forward (F-36 / J-02) so every new alert condition gets the
 * same dedup, idempotency and logging behaviour instead of a fourth
 * copy-pasted variant.
 *
 * This does not migrate the existing hand-rolled call sites — those live in
 * files owned by CP-FLEET/CP-BILL under the cross-repo remediation plan's
 * file-ownership table, and moving them is their call to make in their own
 * branch. New alert conditions (e.g. lease-pool exhaustion, stuck job
 * claims, pending-job age, empty route directory) should use this helper.
 *
 * `operational_alerts` schema assumed (matches existing call sites):
 *   alert_type text, severity text, dedup_key text, node_id text|null,
 *   message text, status text ('open'|'resolved'), resolved_at timestamptz|null
 */

import { logEvent } from "./logging.js";
import { dispatchAlert } from "./alert-dispatch.js";

/**
 * Opens (or re-affirms) an alert. Safe to call repeatedly for the same
 * condition — a duplicate `dedup_key` while the alert is still open is a
 * unique-constraint conflict (23505) and is swallowed, not retried.
 *
 * @param {object} supabaseAdmin - service-role Supabase client
 * @param {object} params
 * @param {string} params.kind - short stable alert type, e.g. "lease_pool_exhausted"
 * @param {"info"|"warning"|"critical"} params.severity
 * @param {string} params.dedupKey - stable per-condition key, e.g. `node:${nodeId}:lease_pool_exhausted`
 * @param {string} params.message - human-readable summary, no secrets
 * @param {string} [params.nodeId]
 * @param {string} [params.requestId] - threaded into the fallback log line if the insert itself fails
 * @param {object} [params.env] - Worker/Function env bindings. Opt-in only:
 *   when present, a successfully-(re)raised alert is additionally handed to
 *   alert-dispatch.js's dispatchAlert() (currently: email, `critical` only)
 *   after the row is written. Omitting it (existing call sites) keeps
 *   dispatch off and behaviour unchanged -- this is a seam for wiring a
 *   real paging vendor later, not a behaviour change today.
 */
export async function raiseAlert(
  supabaseAdmin,
  { kind, severity, dedupKey, message, nodeId = null, requestId = null, env = null }
) {
  const { error } = await supabaseAdmin.from("operational_alerts").insert({
    alert_type: kind,
    severity,
    dedup_key: dedupKey,
    node_id: nodeId,
    message,
  });
  if (error && error.code !== "23505") {
    logEvent("error", "alerts.raise_failed", {
      request_id: requestId,
      alert_type: kind,
      dedup_key: dedupKey,
      error: error.message,
    });
    return { ok: false, error };
  }
  if (env) {
    // Best-effort, never throws past this boundary and never delays the
    // caller's own response -- see dispatchAlert()'s own try/catch per
    // adapter for the isolation this relies on.
    try {
      await dispatchAlert(env, { kind, severity, dedupKey, message, nodeId });
    } catch (err) {
      logEvent("error", "alerts.dispatch_failed", {
        request_id: requestId,
        alert_type: kind,
        dedup_key: dedupKey,
        error: err.message,
      });
    }
  }
  return { ok: true, error: null };
}

/**
 * Resolves an open alert for a dedup key, e.g. once the condition clears.
 * A no-op (not an error) if nothing was open for that key.
 */
export async function resolveAlert(supabaseAdmin, dedupKey, { requestId = null } = {}) {
  const { error } = await supabaseAdmin
    .from("operational_alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("dedup_key", dedupKey)
    .eq("status", "open");
  if (error) {
    logEvent("error", "alerts.resolve_failed", {
      request_id: requestId,
      dedup_key: dedupKey,
      error: error.message,
    });
    return { ok: false, error };
  }
  return { ok: true, error: null };
}

/**
 * Convenience wrapper matching the reconcile-on-every-poll shape used by
 * agent/heartbeat.js today: raise when `active` is true, resolve otherwise.
 */
export async function reconcileAlert(
  supabaseAdmin,
  { kind, active, severity, dedupKey, message, nodeId = null, requestId = null, env = null }
) {
  if (active) {
    return raiseAlert(supabaseAdmin, { kind, severity, dedupKey, message, nodeId, requestId, env });
  }
  return resolveAlert(supabaseAdmin, dedupKey, { requestId });
}
