/**
 * Writes one row to admin_audit_log. Every /api/admin/* mutation route
 * calls this after its provisioning_jobs insert succeeds (never before —
 * an audit-log write failure must not block a real mutation, and a
 * mutation failure must not produce a misleading audit row).
 *
 * NEVER put a subscription URL, VPN token, node API key, or private key
 * into metadata. metadata is for identifiers only (node_id, job_id,
 * vpn_account_id) — see docs/superpowers/plans/2026-09-22-admin-dashboard.md
 * Global Constraints.
 */
export async function writeAdminAudit(
  supabaseAdmin,
  { adminUserId, action, targetType, targetId, metadata = {} }
) {
  const { error } = await supabaseAdmin.from("admin_audit_log").insert({
    admin_user_id: adminUserId,
    action,
    target_type: targetType,
    target_id: String(targetId),
    metadata,
  });
  if (error) {
    console.error("writeAdminAudit: insert failed:", error.message);
  }
}
