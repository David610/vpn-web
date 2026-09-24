import { getAccountMembers } from "./accounts.js";
import { reconcileAccountProvisioning } from "./device-provisioning.js";

/**
 * Reconciles every device of an account with an already-resolved effective
 * entitlement. This is deliberately job-based: the web control plane never
 * mutates sing-box state directly.
 *
 * Per device, not per member: each device has its own VPN identity on the
 * node(s) it is placed on (functions/lib/device-provisioning.js), so
 * disabling, extending or enabling access reaches every identity wherever
 * it lives -- not just the legacy node-1 row.
 *
 * The entitlement carries serviceExpiresAt/clearExpiry rather than merely a
 * Stripe period end, because a support grant may extend paid access or make
 * it intentionally non-expiring.
 *
 * @returns the per-device reconcile results (see reconcileDeviceProvisioning)
 */
export async function syncAccountProvisioningToEntitlement(
  supabaseAdmin,
  accountId,
  entitlement,
  idempotencyPrefix,
  env = {}
) {
  const members = await getAccountMembers(supabaseAdmin, accountId);
  return reconcileAccountProvisioning(supabaseAdmin, env, {
    accountId,
    members,
    entitlement,
    idempotencyPrefix,
  });
}
