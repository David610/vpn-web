import { describe, it, expect, vi } from "vitest";
import { createNodeRevision } from "../node-revisions.js";

function makeSupabase({ latestRevision = null, deleteError = null, insertError = null, updateError = null, enqueueError = null }) {
  const revisionsInsert = vi.fn().mockResolvedValue({ error: insertError });
  const nodesUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: updateError }) });
  const jobsDelete = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: deleteError }) }),
    }),
  });
  const jobsInsert = vi.fn().mockResolvedValue({ error: enqueueError });

  const from = vi.fn((table) => {
    if (table === "node_revisions") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: latestRevision == null ? null : { revision: latestRevision },
          error: null,
        }),
        insert: revisionsInsert,
      };
    }
    if (table === "nodes") {
      return { update: nodesUpdate };
    }
    if (table === "provisioning_jobs") {
      return { delete: jobsDelete, insert: jobsInsert };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { from, revisionsInsert, nodesUpdate, jobsDelete, jobsInsert };
}

describe("createNodeRevision", () => {
  it("starts a brand-new node at revision 1", async () => {
    const supabase = makeSupabase({ latestRevision: null });
    const result = await createNodeRevision(supabase, { nodeId: "de-fra-1", config: { a: 1 } });
    expect(result).toEqual({ revision: 1 });
    expect(supabase.revisionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: "de-fra-1", revision: 1, config: { a: 1 } })
    );
  });

  it("increments from the latest existing revision", async () => {
    const supabase = makeSupabase({ latestRevision: 5 });
    const result = await createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} });
    expect(result).toEqual({ revision: 6 });
  });

  it("advances nodes.desired_revision to the new revision", async () => {
    const supabase = makeSupabase({ latestRevision: 5 });
    await createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} });
    expect(supabase.nodesUpdate).toHaveBeenCalledWith({ desired_revision: 6 });
  });

  it("coalesces by deleting any earlier pending APPLY_NODE_REVISION job before enqueuing the new one", async () => {
    const supabase = makeSupabase({ latestRevision: 1 });
    await createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} });
    expect(supabase.jobsDelete).toHaveBeenCalled();
    expect(supabase.jobsInsert).toHaveBeenCalledWith({
      node_id: "de-fra-1",
      job_type: "APPLY_NODE_REVISION",
      payload: { revision: 2 },
    });
  });

  it("propagates a node_revisions insert error instead of silently advancing desired_revision", async () => {
    const supabase = makeSupabase({ latestRevision: null, insertError: { message: "boom" } });
    await expect(createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} })).rejects.toThrow(
      /node_revisions insert failed/
    );
    expect(supabase.nodesUpdate).not.toHaveBeenCalled();
  });

  it("propagates a provisioning_jobs enqueue error", async () => {
    const supabase = makeSupabase({ latestRevision: null, enqueueError: { message: "boom" } });
    await expect(createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} })).rejects.toThrow(
      /provisioning_jobs insert failed/
    );
  });

  it("treats a 23505 from the enqueue insert as a benign concurrent-call race, not a failure", async () => {
    // provisioning_jobs_one_pending_apply_revision_per_node (the migration's
    // partial unique index) is what actually makes the "never more than one
    // pending job" invariant hold under concurrency -- a 23505 here means a
    // concurrent createNodeRevision() call for the same node already has a
    // pending job in flight, which itself satisfies the invariant.
    const supabase = makeSupabase({ latestRevision: null, enqueueError: { code: "23505", message: "duplicate" } });
    const result = await createNodeRevision(supabase, { nodeId: "de-fra-1", config: {} });
    expect(result).toEqual({ revision: 1 });
  });
});
