/**
 * Writes one row to admin_audit_log. Every /api/admin/* mutation route
 * calls this after its provisioning_jobs insert succeeds (never before —
 * a mutation failure must not produce a misleading audit row).
 *
 * F-39: this is still a separate write after the mutation, not the same
 * transaction/RPC (the mutation and the audit insert can still diverge if
 * the process dies between the two). Short of moving every admin mutation
 * into a single RPC — tracked as follow-up work, and for routes whose
 * mutation logic is owned by CP-BILL/CP-FLEET, only they can make that
 * change — this function is hardened to fail closed instead of
 * best-effort: an audit-log write failure now throws, so the caller's
 * response reflects that the operation is not fully recorded rather than
 * silently logging to the console and returning success. Callers that
 * want the mutation itself to still succeed even if audit logging fails
 * must decide that explicitly, not get it as a hidden default.
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
    throw new Error(`writeAdminAudit: insert failed: ${error.message}`);
  }
}
