import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { isValidLifecycleState, canTransitionLifecycle } from "../../../../lib/node-lifecycle.js";
import { sha256Hex } from "../../../../lib/crypto.js";
import { generateHexSecret, ENROLLMENT_TOKEN_TTL_MS } from "../../../../lib/node-enrollment.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestPatch({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") {
    return jsonResponse({ error: "Read-only admins cannot perform this action" }, 403);
  }

  const nodeId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!isValidLifecycleState(body?.state)) {
    return jsonResponse({ error: "state must be a valid node lifecycle state" }, 400);
  }

  try {
    const { data: node, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, lifecycle_state")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!node) return jsonResponse({ error: "Node not found" }, 404);

    if (!canTransitionLifecycle(node.lifecycle_state, body.state)) {
      return jsonResponse(
        { error: `Cannot transition from ${node.lifecycle_state} to ${body.state}` },
        409
      );
    }

    // F-05/C-09: QUARANTINED/RETIRED must revoke the node's key, cancel its
    // in-flight jobs, drop its lease slots, and bump the route-directory
    // version all in the SAME transaction as the lifecycle write -- a node
    // suspected of compromise cannot be left able to keep authenticating,
    // holding a claimed job, or being handed lease slots for even one
    // request after an admin decides to quarantine/retire it. This goes
    // through a single RPC (supabase-js has no cross-table transaction) and
    // returns before any of the plain-UPDATE path below runs.
    if (body.state === "QUARANTINED" || body.state === "RETIRED") {
      // F-06: RETIRED normally requires dns_removed_at to already be set
      // (set by fleet-operations.js's RETIRE_OLD_NODE before it ever
      // requests RETIRED). A manual admin retirement of a node whose DNS
      // was never programmatically published can legitimately need to
      // bypass that — only with an explicit, audited flag, never silently.
      const overrideDnsCheck = body.state === "RETIRED" && body.overrideDnsCheck === true;

      // F-20/B-03: a direct admin RETIRE (as opposed to the REPLACE_NODE
      // saga's own RETIRE_OLD_NODE step, which only ever reaches RETIRED
      // once device_node_assignments is empty or its own audited
      // maxWaitHours timeout has explicitly elapsed) had no equivalent
      // check at all -- an admin could retire a node straight out from
      // under every legacy device still assigned to it. Same
      // explicit-override shape as overrideDnsCheck just above: refuse by
      // default, allow only with a deliberate, audited flag.
      let assignmentsOverridden = false;
      if (body.state === "RETIRED") {
        const { count: liveAssignments, error: assignError } = await supabaseAdmin
          .from("device_node_assignments")
          .select("device_id", { count: "exact", head: true })
          .eq("node_id", nodeId);
        if (assignError) throw new Error(`device_node_assignments count failed: ${assignError.message}`);
        if ((liveAssignments ?? 0) > 0) {
          if (body.overrideAssignmentsCheck !== true) {
            return jsonResponse(
              {
                error: `Node still has ${liveAssignments} device assignment(s). Re-place them first, or pass overrideAssignmentsCheck: true to retire anyway (audited).`,
              },
              409
            );
          }
          assignmentsOverridden = true;
        }
      }

      // F-39: the audit row for this transition is now written by the RPC
      // itself, in the same transaction as the lifecycle/key-revocation
      // writes above — no separate writeAdminAudit call after, so a crash
      // between "mutation committed" and "audit written" is no longer
      // possible for this route's highest-risk transitions.
      const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc("revoke_node_key_and_transition", {
        p_node_id: nodeId,
        p_to_state: body.state,
        p_expected_from_state: node.lifecycle_state,
        p_override_dns_check: overrideDnsCheck,
        p_admin_user_id: admin.userId,
        p_audit_metadata: {
          reissued_enrollment_token: false,
          ...(overrideDnsCheck ? { dns_check_overridden: true } : {}),
          ...(assignmentsOverridden ? { assignments_check_overridden: true } : {}),
        },
      });
      if (rpcError) throw new Error(`revoke_node_key_and_transition failed: ${rpcError.message}`);
      if (rpcResult?.status === "not_found") return jsonResponse({ error: "Node not found" }, 404);
      if (rpcResult?.status === "stale") {
        return jsonResponse(
          { error: "Node lifecycle_state changed concurrently — reload and retry" },
          409
        );
      }
      if (rpcResult?.status === "dns_not_removed") {
        return jsonResponse(
          {
            error:
              "Node's DNS record has not been confirmed removed. Retry after RETIRE_OLD_NODE completes, or pass overrideDnsCheck: true to retire anyway (audited).",
          },
          409
        );
      }

      return jsonResponse({ ok: true, lifecycleState: body.state });
    }

    // Every path reaching here is neither QUARANTINED nor RETIRED (both
    // returned above via the RPC), so retired_at never needs to be set on
    // this plain-UPDATE path.
    const update = {
      lifecycle_state: body.state,
      lifecycle_state_changed_at: new Date().toISOString(),
      // failed_reason precondition (Phase 12a/12b specs): an admin-forced
      // FAILED must be distinguishable from a silence-FAILED, so Phase 8's
      // probe-based auto-recovery never waves it back to READY on its own.
      // Any other transition clears a stale value from a prior FAILED spell.
      failed_reason: body.state === "FAILED" ? "ADMIN" : null,
    };

    // A node can re-enter PROVISIONING (e.g. FAILED -> PROVISIONING, a
    // retry). If it still has an unexpired enrollment token from a
    // previous, possibly-leaked attempt (functions/api/agent/enroll.js's
    // consuming UPDATE never runs unless that exact token is presented,
    // so a token that was never spent stays valid for its full TTL
    // regardless of what the node's lifecycle_state does in the
    // meantime), whoever holds that old token could still redeem it and
    // claim the node's real API key ahead of the legitimate VPS. Mint a
    // fresh token on every transition into PROVISIONING so any prior one
    // is unconditionally invalidated, and return it the same way POST
    // /api/admin/nodes does.
    let enrollmentToken = null;
    if (body.state === "PROVISIONING") {
      enrollmentToken = generateHexSecret();
      update.enrollment_token_hash = await sha256Hex(enrollmentToken);
      update.enrollment_token_expires_at = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS).toISOString();
    }

    // Guard the write on the lifecycle_state this request actually
    // validated against, not just node_id: without it, two concurrent
    // requests both reading READY (one going to QUARANTINED, one to
    // DRAINING) can both pass canTransitionLifecycle and the second
    // UPDATE silently overwrites the first's result — including undoing
    // a just-applied QUARANTINED, which is supposed to be a one-way
    // security containment (spec §45). If zero rows match, someone else's
    // transition landed first; the client should re-read and retry
    // rather than get a false "ok" for a write that never happened.
    //
    // F-39 round 2: this UPDATE and its admin_audit_log row now commit
    // together in a single RPC (see
    // 20261010000000_admin_audit_transactional_round2.sql), the same
    // pattern the QUARANTINED/RETIRED branch above already uses via
    // revoke_node_key_and_transition.
    const { data: rpcResult, error: updateError } = await supabaseAdmin.rpc(
      "admin_update_node_lifecycle_with_audit",
      {
        p_node_id: nodeId,
        p_to_state: body.state,
        p_expected_from_state: node.lifecycle_state,
        p_failed_reason: update.failed_reason,
        p_enrollment_token_hash: update.enrollment_token_hash ?? null,
        p_enrollment_token_expires_at: update.enrollment_token_expires_at ?? null,
        p_admin_user_id: admin.userId,
        // Never the token or its hash here — admin-audit.js's contract is
        // identifiers only, same as everywhere else this file is written to.
        p_audit_metadata: { reissued_enrollment_token: !!enrollmentToken },
      }
    );
    if (updateError) throw new Error(`nodes update failed: ${updateError.message}`);
    if (rpcResult?.status === "stale") {
      return jsonResponse(
        { error: "Node lifecycle_state changed concurrently — reload and retry" },
        409
      );
    }

    return jsonResponse({
      ok: true,
      lifecycleState: body.state,
      ...(enrollmentToken ? { enrollmentToken, expiresAt: update.enrollment_token_expires_at } : {}),
    });
  } catch (err) {
    console.error("admin/nodes/:id/lifecycle: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
