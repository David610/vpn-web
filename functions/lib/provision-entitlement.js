import { getAccountMembers, getMemberVpnAccounts } from "./accounts.js";
import { resolveNodeForUser } from "./resolve-node.js";

async function insertJob(supabaseAdmin, row) {
  const { error } = await supabaseAdmin.from("provisioning_jobs").insert(row);
  if (error && error.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${error.message}`);
  }
}

/**
 * Reconciles every current account member with an already-resolved effective
 * entitlement. This is deliberately job-based: the web control plane never
 * mutates sing-box state directly.
 */
export async function syncAccountProvisioningToEntitlement(
  supabaseAdmin,
  accountId,
  entitlement,
  idempotencyPrefix
) {
  const nodeId = resolveNodeForUser();
  const members = await getAccountMembers(supabaseAdmin, accountId);
  const vpnAccounts = await getMemberVpnAccounts(supabaseAdmin, accountId, nodeId);
  const vpnByUser = new Map(vpnAccounts.map((v) => [v.userId, v]));

  for (const member of members) {
    const vpn = vpnByUser.get(member.userId);

    if (!entitlement) {
      if (!vpn) continue;
      await insertJob(supabaseAdmin, {
        idempotency_key: `${idempotencyPrefix}:disable:${vpn.id}`,
        node_id: nodeId,
        job_type: "DISABLE_USER",
        vpn_account_id: vpn.id,
        payload: { vpn_user_id: vpn.vpnUserId, user_id: member.userId },
      });
      continue;
    }

    if (!vpn) {
      const payload = { user_id: member.userId };
      if (entitlement.currentPeriodEnd) {
        payload.expires_at = entitlement.currentPeriodEnd;
      }
      await insertJob(supabaseAdmin, {
        idempotency_key: `${idempotencyPrefix}:create:${member.userId}`,
        node_id: nodeId,
        job_type: "CREATE_USER",
        vpn_account_id: null,
        payload,
      });
      continue;
    }

    if (entitlement.currentPeriodEnd) {
      await insertJob(supabaseAdmin, {
        idempotency_key: `${idempotencyPrefix}:expiry:${vpn.id}`,
        node_id: nodeId,
        job_type: "SET_EXPIRY",
        vpn_account_id: vpn.id,
        payload: {
          vpn_user_id: vpn.vpnUserId,
          expires_at: entitlement.currentPeriodEnd,
        },
      });
    } else {
      await insertJob(supabaseAdmin, {
        idempotency_key: `${idempotencyPrefix}:clear-expiry:${vpn.id}`,
        node_id: nodeId,
        job_type: "CLEAR_EXPIRY",
        vpn_account_id: vpn.id,
        payload: { vpn_user_id: vpn.vpnUserId },
      });
    }

    await insertJob(supabaseAdmin, {
      idempotency_key: `${idempotencyPrefix}:enable:${vpn.id}`,
      node_id: nodeId,
      job_type: "ENABLE_USER",
      vpn_account_id: vpn.id,
      payload: { vpn_user_id: vpn.vpnUserId, user_id: member.userId },
    });
  }
}
