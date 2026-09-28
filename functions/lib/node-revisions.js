/**
 * Declarative node revisions (spec 54 Phase 6). createNodeRevision() is the
 * one place that writes a new desired-state snapshot for a node: it inserts
 * an immutable node_revisions row, advances nodes.desired_revision, and
 * enqueues the agent's APPLY_NODE_REVISION job -- coalesced so a rapid
 * sequence of desired-state changes never leaves more than one pending
 * apply job per node (the agent always fetches whatever revision is
 * current by the time it gets around to polling, so stale intermediate
 * jobs are pure queue churn, not correctness -- see scheduler.js's own
 * "additive, not yet wired into a live caller" precedent from Phase 5;
 * this module is the same: nothing calls it yet, later phases (8, 12) do).
 */
export async function createNodeRevision(supabaseAdmin, { nodeId, config, reason = null, createdBy = null }) {
  const { data: latest, error: latestError } = await supabaseAdmin
    .from("node_revisions")
    .select("revision")
    .eq("node_id", nodeId)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`node_revisions lookup failed: ${latestError.message}`);

  const revision = (latest?.revision ?? 0) + 1;

  const { error: insertError } = await supabaseAdmin.from("node_revisions").insert({
    node_id: nodeId,
    revision,
    config,
    reason,
    created_by: createdBy,
  });
  if (insertError) throw new Error(`node_revisions insert failed: ${insertError.message}`);

  const { error: updateError } = await supabaseAdmin
    .from("nodes")
    .update({ desired_revision: revision })
    .eq("node_id", nodeId);
  if (updateError) throw new Error(`nodes desired_revision update failed: ${updateError.message}`);

  // Coalesce: a node should never have more than one pending
  // APPLY_NODE_REVISION job. Delete any earlier one before enqueuing this
  // revision's -- provisioning_jobs.status has no "canceled" value (only
  // pending/claimed/done/failed), so a still-pending, not-yet-claimed job
  // is simply superseded rather than kept around as dead state. If the
  // agent already claimed it (status != 'pending'), leave it alone; it's
  // already in flight and will pick up this new revision on its next poll
  // regardless, same as any other superseded-but-already-running job.
  //
  // This delete-then-insert is not itself atomic across two concurrent
  // createNodeRevision() calls for the same node -- the migration's
  // provisioning_jobs_one_pending_apply_revision_per_node partial unique
  // index is what actually makes the invariant hold; a 23505 from it below
  // means a concurrent call's job already covers this node, which is fine.
  const { error: cancelError } = await supabaseAdmin
    .from("provisioning_jobs")
    .delete()
    .eq("node_id", nodeId)
    .eq("job_type", "APPLY_NODE_REVISION")
    .eq("status", "pending");
  if (cancelError) throw new Error(`provisioning_jobs coalesce failed: ${cancelError.message}`);

  // F-17 fix: provisioning_jobs.idempotency_key is NOT NULL + unique. This
  // insert used to omit it entirely, so every APPLY_NODE_REVISION enqueue
  // failed with 23502 (not_null_violation) -- never the 23505 this code
  // was written to tolerate -- meaning node revision rollout always threw
  // here and the caller never got its {revision} result. Give it a
  // deterministic key so a genuine race with another concurrent enqueue for
  // the same node+revision collides on 23505 (intentionally tolerated
  // below) instead of writing a duplicate job.
  const { error: enqueueError } = await supabaseAdmin.from("provisioning_jobs").insert({
    node_id: nodeId,
    job_type: "APPLY_NODE_REVISION",
    idempotency_key: `apply-revision:${nodeId}:${revision}`,
    payload: { revision },
  });
  if (enqueueError && enqueueError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${enqueueError.message}`);
  }

  return { revision };
}
