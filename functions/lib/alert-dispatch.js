/**
 * Generic alert-dispatch seam (Phase 15 / observability).
 *
 * This is wiring, not a vendor choice: picking an external paging
 * destination (Slack, PagerDuty, OpsGenie, ...) is the operator's
 * infrastructure decision, not something to hard-code here. What this file
 * gives instead is one small, stable extension point so that decision is a
 * follow-up of "write one more adapter function", not a rewrite of every
 * alert call site.
 *
 * dispatchAlert(env, alert) is called from alerts.js's raiseAlert() (only
 * when a caller opts in by passing `env`) right after the operational_alerts
 * row is written. It fans out to every adapter in `adapters`, isolating each
 * one's failure so a broken channel never throws back into the alert path
 * and never blocks or rolls back the row that already recorded the
 * condition -- the database row is always the source of truth; dispatch is
 * best-effort delivery on top of it.
 *
 * Today's only adapter is email (functions/lib/resend.js), reusing the same
 * ALERT_TO_EMAIL/RESEND_API_KEY gating sendFailureAlert already used, and
 * only for `critical` severity (an inbox is not a good place for every
 * warning/info row -- those stay queryable in operational_alerts /
 * GET /api/admin/alerts until a real paging vendor is wired in).
 *
 * To add a vendor later: write an adapter of the shape
 *   { name: string, send(env, alert): Promise<void> }
 * and push it into `adapters`. Nothing else changes.
 */

import { sendOperationalAlertEmail } from "./resend.js";

const emailAdapter = {
  name: "email",
  async send(env, alert) {
    if (!env.RESEND_API_KEY || !env.ALERT_TO_EMAIL) return;
    await sendOperationalAlertEmail(env, alert);
  },
};

const adapters = [emailAdapter];

/**
 * @param {object} env - Worker/Function env bindings (RESEND_API_KEY, ALERT_TO_EMAIL, ...)
 * @param {object} alert
 * @param {string} alert.kind
 * @param {"info"|"warning"|"critical"} alert.severity
 * @param {string} alert.dedupKey
 * @param {string} alert.message - human-readable, must not contain secrets
 * @param {string|null} [alert.nodeId]
 */
export async function dispatchAlert(env, alert) {
  if (!env || alert.severity !== "critical") return;
  for (const adapter of adapters) {
    try {
      await adapter.send(env, alert);
    } catch (err) {
      console.error(`alert-dispatch: ${adapter.name} adapter failed:`, err.message);
    }
  }
}
