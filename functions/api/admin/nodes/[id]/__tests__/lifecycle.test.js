import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodeMaybeSingle = vi.fn();
const auditInsert = vi.fn();
const credDeleteEq = vi.fn(async () => ({ error: null }));
const credDelete = vi.fn(() => ({ eq: credDeleteEq }));
const revokeRpc = vi.fn();
const lifecycleUpdateRpc = vi.fn();
const rpc = vi.fn((fn, args) => {
  if (fn === "revoke_node_key_and_transition") return revokeRpc(args);
  if (fn === "admin_update_node_lifecycle_with_audit") return lifecycleUpdateRpc(args);
  throw new Error(`unexpected rpc ${fn}`);
});
// F-20/B-03: the RETIRED path now counts live device_node_assignments
// before calling the revoke RPC. Defaults to zero live assignments so
// every pre-existing test (which predates this check) keeps passing
// unchanged; the dedicated assignments tests below override this count.
const assignmentsCount = vi.fn(async () => ({ count: 0, error: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "nodes") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: nodeMaybeSingle };
      }
      if (table === "admin_audit_log") return { insert: auditInsert };
      if (table === "node_probe_credentials") return { delete: credDelete };
      if (table === "device_node_assignments") {
        return { select: vi.fn(() => ({ eq: assignmentsCount })) };
      }
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
  credDelete.mockClear();
  credDeleteEq.mockClear();
  auditInsert.mockReset().mockResolvedValue({ error: null });
  revokeRpc.mockReset().mockResolvedValue({ data: { status: "ok", jobs_cancelled: 0, lease_slots_deleted: 0 }, error: null });
  lifecycleUpdateRpc.mockReset().mockResolvedValue({ data: { status: "ok" }, error: null });
  rpc.mockClear();
  assignmentsCount.mockReset().mockResolvedValue({ count: 0, error: null });
});

describe("PATCH /api/admin/nodes/:id/lifecycle", () => {
  it("returns 400 for an unknown state", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "BOGUS" }), params: { id: "node-1" } });
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 403 for a readonly admin and does not mutate the node", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
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
    expect(rpc).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  // F-39 round 2: the plain-UPDATE path (any transition other than into
  // QUARANTINED/RETIRED) now goes through admin_update_node_lifecycle_with_
  // audit — one RPC that commits the nodes UPDATE and the admin_audit_log
  // row in the same transaction (see
  // 20261010000000_admin_audit_transactional_round2.sql) — instead of a
  // plain nodes.update() followed by a separate writeAdminAudit() call.
  it("applies an allowed transition via the atomic lifecycle-update RPC", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, lifecycleState: "DRAINING" });
    expect(lifecycleUpdateRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        p_node_id: "node-1",
        p_to_state: "DRAINING",
        p_expected_from_state: "READY",
        p_admin_user_id: "admin-1",
        p_audit_metadata: { reissued_enrollment_token: false },
      })
    );
    // No separate admin_audit_log insert — the RPC wrote it atomically.
    expect(auditInsert).not.toHaveBeenCalled();
  });

  // F-05/C-09: RETIRED (and QUARANTINED) go through the atomic
  // revoke_node_key_and_transition RPC instead of the plain nodes UPDATE —
  // key revocation, job cancellation, lease-slot cleanup and the route-
  // directory version bump all happen in that one transaction, never via
  // separate supabase-js calls that could partially fail.
  it("transitions to RETIRED via the atomic revoke RPC, not the lifecycle-update RPC", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "DRAINING" }, error: null });
    revokeRpc.mockResolvedValue({ data: { status: "ok", jobs_cancelled: 2, lease_slots_deleted: 3 }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lifecycleState: "RETIRED" });
    expect(revokeRpc).toHaveBeenCalledWith({
      p_node_id: "node-1",
      p_to_state: "RETIRED",
      p_expected_from_state: "DRAINING",
      p_override_dns_check: false,
      p_admin_user_id: "admin-1",
      p_audit_metadata: { reissued_enrollment_token: false },
    });
    expect(lifecycleUpdateRpc).not.toHaveBeenCalled();
    // F-39: the audit row for QUARANTINED/RETIRED now commits inside the
    // RPC's own transaction (see 20261008000000_admin_audit_transactional
    // .sql) — this route no longer makes a separate admin_audit_log insert
    // for that branch at all.
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("transitions to QUARANTINED via the atomic revoke RPC", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "QUARANTINED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(revokeRpc).toHaveBeenCalledWith({
      p_node_id: "node-1",
      p_to_state: "QUARANTINED",
      p_expected_from_state: "READY",
      p_override_dns_check: false,
      p_admin_user_id: "admin-1",
      p_audit_metadata: { reissued_enrollment_token: false },
    });
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when the revoke RPC reports the node's DNS has not been removed", async () => {
    revokeRpc.mockResolvedValue({ data: { status: "dns_not_removed" }, error: null });
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
    expect(revokeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        p_override_dns_check: true,
        p_audit_metadata: expect.objectContaining({ dns_check_overridden: true }),
      })
    );
    expect(auditInsert).not.toHaveBeenCalled();
  });

  // F-20/B-03: RETIRE must refuse while live device assignments remain,
  // unless the admin explicitly passes the audited override.
  it("refuses RETIRED with live assignments and never calls the revoke RPC", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "DRAINING" }, error: null });
    assignmentsCount.mockResolvedValue({ count: 3, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("retires with live assignments when overrideAssignmentsCheck is explicitly requested", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "DRAINING" }, error: null });
    assignmentsCount.mockResolvedValue({ count: 3, error: null });
    const res = await onRequestPatch({
      env,
      request: makeRequest({ state: "RETIRED", overrideAssignmentsCheck: true }),
      params: { id: "node-1" },
    });
    expect(res.status).toBe(200);
    expect(revokeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        p_to_state: "RETIRED",
        p_audit_metadata: expect.objectContaining({ assignments_check_overridden: true }),
      })
    );
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("returns 409 without a false ok when the revoke RPC reports a stale lifecycle_state", async () => {
    revokeRpc.mockResolvedValue({ data: { status: "stale", lifecycle_state: "QUARANTINED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "RETIRED" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("propagates an error from the revoke RPC as a 500 instead of a false ok", async () => {
    revokeRpc.mockResolvedValue({ data: null, error: { message: "db down" } });
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

    const call = lifecycleUpdateRpc.mock.calls[0][0];
    expect(call.p_enrollment_token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Only the hash is stored — never the raw token.
    expect(call.p_enrollment_token_hash).not.toBe(body.enrollmentToken);
    expect(call.p_audit_metadata).toEqual(expect.objectContaining({ reissued_enrollment_token: true }));
  });

  // failed_reason precondition (Phase 12a/12b specs): an admin-forced FAILED
  // must be distinguishable from a silence-FAILED, so Phase 8's automated
  // recovery doesn't wave it back to READY on the node's next lucky probe.
  it("records failed_reason as ADMIN when transitioning a node to FAILED", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "READY" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "FAILED" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(lifecycleUpdateRpc).toHaveBeenCalledWith(expect.objectContaining({ p_failed_reason: "ADMIN" }));
  });

  it("clears failed_reason when transitioning a node away from FAILED", async () => {
    nodeMaybeSingle.mockResolvedValue({ data: { node_id: "node-1", lifecycle_state: "FAILED" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "PROVISIONING" }), params: { id: "node-1" } });
    expect(res.status).toBe(200);
    expect(lifecycleUpdateRpc).toHaveBeenCalledWith(expect.objectContaining({ p_failed_reason: null }));
  });

  it("does not include an enrollment token for a non-PROVISIONING transition", async () => {
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    const body = await res.json();
    expect(body.enrollmentToken).toBeUndefined();
    expect(lifecycleUpdateRpc).toHaveBeenCalledWith(expect.objectContaining({ p_enrollment_token_hash: null }));
  });

  it("returns 409 without a false ok when another request's transition wins the race", async () => {
    // The read saw READY, canTransitionLifecycle allows READY->DRAINING,
    // but by the time the guarded UPDATE runs, another request has
    // already moved the node to QUARANTINED — the RPC's own guarded UPDATE
    // matches zero rows and reports "stale".
    lifecycleUpdateRpc.mockResolvedValue({ data: { status: "stale" }, error: null });
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(409);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  // F-39 round 2 atomicity: the plain-UPDATE path's mutation and its audit
  // row are written by a single RPC/transaction. If that RPC fails, the
  // route must not report success and must make no separate mutation or
  // audit write of its own -- there is no split-brain state to produce.
  it("propagates an error from the lifecycle-update RPC as a 500 instead of a false ok", async () => {
    lifecycleUpdateRpc.mockResolvedValue({ data: null, error: { message: "simulated transaction failure" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await onRequestPatch({ env, request: makeRequest({ state: "DRAINING" }), params: { id: "node-1" } });
    expect(res.status).toBe(500);
    expect(auditInsert).not.toHaveBeenCalled();
  });
});
