import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodeMaybeSingle = vi.fn();
const nodeUpdateMaybeSingle = vi.fn();
const nodeUpdateChain = {
  eq: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  maybeSingle: nodeUpdateMaybeSingle,
};
const nodeUpdate = vi.fn(() => nodeUpdateChain);
const auditInsert = vi.fn();
const credDeleteEq = vi.fn(async () => ({ error: null }));
const credDelete = vi.fn(() => ({ eq: credDeleteEq }));
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "nodes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: nodeMaybeSingle,
          update: nodeUpdate,
        };
      }
      if (table === "admin_audit_log") return { insert: auditInsert };
      if (table === "node_probe_credentials") return { delete: credDelete };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestPatch } = await import("../lifecycle.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/admin/nodes/node-1/lifecycle", {
    method: "PATCH",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "READY" }, error: null });
  nodeUpdateMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1" }, error: null });
  nodeUpdate.mockClear();
  credDelete.mockClear();
  credDeleteEq.mockClear();
  nodeUpdateChain.eq.mockClear();
  auditInsert.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset().mockResolvedValue({ data: { status: "ok", jobs_cancelled: 0, lease_slots_deleted: 0 }, error: null });
});

describe("PATCH /api/admin/nodes/:id/lifecycle", () => {
  it("returns 400 for an unknown state", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "BOGUS" }), params: { id: "node-1" } });
    expect(res.status).toBe(400);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("returns 403 for a readonly admin and does not mutate the node", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(403);
    expect(nodeUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the node does not exist", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("returns 409 and does not mutate the node for a disallowed transition", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "RETIRED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "READY" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(nodeUpdate).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("applies an allowed transition, guards the write on the read state, and writes an audit row", async () => {
    const before = Date.now();
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, lifecycleState: "DRAINING" });
    expect(nodeUpdate).toHaveBeenCalledWith(expect.objectContaining({ lifecycle_state: "DRAINING" }));
    expect(nodeUpdate.mock.calls[0][0]).not.toHaveProperty("retired_at");
    // The UPDATE must be guarded by the lifecycle_state this request
    // actually read (READY), not just node_id — see lifecycle.js's
    // comment on the concurrent-transition race this closes.
    expect(nodeUpdateChain.eq).toHaveBeenCalledWith("lifecycle_state", "READY");
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.node_lifecycle_transition",
        target_type: "node",
        target_id: "node-1",
        metadata: { from: "READY", to: "DRAINING", reissued_enrollment_token: false },
      })
    );
    expect(new Date(nodeUpdate.mock.calls[0][0].lifecycle_state_changed_at).getTime()).toBeGreaterThan(before - 1);
  });

  // F-05/C-09: RETIRED (and QUARANTINED) go through the atomic
  // revoke_node_key_and_transition RPC instead of the plain nodes UPDATE —
  // key revocation, job cancellation, lease-slot cleanup and the route-
  // directory version bump all happen in that one transaction, never via
  // separate supabase-js calls that could partially fail.
  it("transitions to RETIRED via the atomic revoke RPC, not the plain UPDATE path", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "DRAINING" }, error: null });
    rpc.mockResolvedValue({ data: { status: "ok", jobs_cancelled: 2, lease_slots_deleted: 3 }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lifecycleState: "RETIRED" });
    expect(rpc).toHaveBeenCalledWith("revoke_node_key_and_transition", {
      p_node_id: "node-1",
      p_to_state: "RETIRED",
      p_expected_from_state: "DRAINING",
      p_override_dns_check: false,
    });
    expect(nodeUpdate).not.toHaveBeenCalled();
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ key_revoked: true, jobs_cancelled: 2, lease_slots_deleted: 3 }),
      })
    );
  });

  it("transitions to QUARANTINED via the atomic revoke RPC", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "QUARANTINED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("revoke_node_key_and_transition", {
      p_node_id: "node-1",
      p_to_state: "QUARANTINED",
      p_expected_from_state: "READY",
      p_override_dns_check: false,
    });
  });

  it("returns 409 when the revoke RPC reports the node's DNS has not been removed", async () => {
    rpc.mockResolvedValue({ data: { status: "dns_not_removed" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("passes the audited override through when overrideDnsCheck is explicitly requested", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "DRAINING" }, error: null });
    const res = await onRequestPatch({
      env,
      request: makeRequest({ state: "RETIRED", overrideDnsCheck: true }),
      params: { id: "node-1" },
    });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "revoke_node_key_and_transition",
      expect.objectContaining({ p_override_dns_check: true })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ dns_check_overridden: true }) })
    );
  });

  it("returns 409 without a false ok when the revoke RPC reports a stale lifecycle_state", async () => {
    rpc.mockResolvedValue({ data: { status: "stale", lifecycle_state: "QUARANTINED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("propagates an error from the revoke RPC as a 500 instead of a false ok", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPatch({ env, request: makeRequest({ state: "QUARANTINED" }), params: { id: "node-1" } });
    expect(res.status).toBe(500);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("reissues a fresh enrollment token and returns it when transitioning back to PROVISIONING", async () => {
    // Closes a real gap: without reissuing, a leaked-but-unexpired token
    // from an earlier enrollment attempt would still be valid after a
    // FAILED -> PROVISIONING retry, letting whoever holds it claim the
    // node's real API key ahead of the legitimate VPS.
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "FAILED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "PROVISIONING" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.enrollmentToken).toBe("string");
    expect(typeof body.expiresAt).toBe("string");

    const update = nodeUpdate.mock.calls[0][0];
    expect(update.enrollment_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Only the hash is stored — never the raw token.
    expect(update.enrollment_token_hash).not.toBe(body.enrollmentToken);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reissued_enrollment_token: true }) })
    );
  });

  // failed_reason precondition (Phase 12a/12b specs): an admin-forced FAILED
  // must be distinguishable from a silence-FAILED, so Phase 8's automated
  // recovery doesn't wave it back to READY on the node's next lucky probe.
  it("records failed_reason as ADMIN when transitioning a node to FAILED", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "READY" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "FAILED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(nodeUpdate).toHaveBeenCalledWith(expect.objectContaining({ failed_reason: "ADMIN" }));
  });

  it("clears failed_reason when transitioning a node away from FAILED", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "FAILED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "PROVISIONING" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(nodeUpdate).toHaveBeenCalledWith(expect.objectContaining({ failed_reason: null }));
  });

  it("does not include an enrollment token for a non-PROVISIONING transition", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    const body = await res.json();
    expect(body.enrollmentToken).toBeUndefined();
    expect(nodeUpdate.mock.calls[0][0]).not.toHaveProperty("enrollment_token_hash");
  });

  it("returns 409 without a false ok when another request's transition wins the race", async () => {
    // The read saw READY, canTransitionLifecycle allows READY->DRAINING,
    // but by the time the guarded UPDATE runs, another request has
    // already moved the node to QUARANTINED — zero rows match the
    // lifecycle_state guard.
    nodeUpdateMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(auditInsert).not.toHaveBeenCalled();
  });
});
