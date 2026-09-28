import { sha256Hex } from "./crypto.js";
import { generateHexSecret, ENROLLMENT_TOKEN_TTL_MS } from "./node-enrollment.js";
import { canTransitionLifecycle } from "./node-lifecycle.js";
import { buildNodeBootstrapUserData } from "./node-bootstrap.js";
import { FAILURE_THRESHOLD, HEARTBEAT_INTERVAL_MS, SILENCE_THRESHOLD_MULTIPLIER } from "./node-health-transition.js";
import { checkDeviceEntitlement } from "./device-entitlement.js";
import { logEvent } from "./logging.js";
import { raiseAlert, resolveAlert } from "./alerts.js";

// F-36: steps whose failure means a DNS create/delete/verify call to the
// adapter (functions/lib/dns/cloudflare.js) failed -- these get a dedicated
// alert on top of the generic step-failure log below, since a stuck DNS
// state can leave a node either unreachable (PUBLISH_DNS) or a retired
// node's hostname dangling and re-claimable (RETIRE_OLD_NODE, see F-06).
const DNS_STEPS = new Set(["PUBLISH_DNS", "RETIRE_OLD_NODE"]);

/**
 * Resumable fleet operations (spec §24 sagas), persisted in
 * fleet_operations / operation_steps.
 *
 * An operation is an ordered list of named steps. advanceOperation() runs
 * steps in order until one has to wait (the node is still booting) or
 * fails. Every step handler is idempotent -- it first checks whether its
 * effect already exists (provider server by label, DNS record by name, node
 * row state) -- so re-running a step after a timeout, a crashed Worker
 * invocation, or a lost lease repeats no side effect. Progress is written
 * after every step, never only at the end.
 *
 * Invoked from two places:
 *   - inline, right after an admin creates the operation (fast feedback);
 *   - the periodic reconciler, functions/api/internal/fleet-tick.js, which
 *     leases due operations via lease_fleet_operations() so two ticks never
 *     advance the same operation concurrently.
 *
 * Nothing stored in operation/step detail or errors may contain a
 * credential: enrollment tokens only ever exist in memory for the single
 * createInstance call that embeds them in user_data.
 */

export class FatalStepError extends Error {}

export const CREATE_NODE_STEPS = [
  "CREATE_INSTANCE",
  "PUBLISH_DNS",
  "AWAIT_ENROLLMENT",
  "AWAIT_BOOTSTRAP",
  "VERIFY_READINESS",
  "MARK_READY",
];

const MAX_STEP_ATTEMPTS = 8;
const CREATE_NODE_DEADLINE_MS = 90 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 180_000;
// Readiness must hold across several probes spaced apart, not one lucky
// sample, before a node is allowed to receive customers.
export const READINESS_CONSECUTIVE_PASSES = 3;
const READINESS_PROBE_INTERVAL_S = 20;

function backoffSeconds(attempt) {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 600);
}

function truncate(text, max = 900) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function loadNode(supabase, nodeId) {
  const { data, error } = await supabase
    .from("nodes")
    .select(
      "node_id, role, lifecycle_state, hostname, provider, provider_instance_id, ip_address, dns_record_id, dns_removed_at, last_seen_at, bootstrap_stage, bootstrap_status, bootstrap_message, consecutive_probe_failures, lifecycle_state_changed_at"
    )
    .eq("node_id", nodeId)
    .maybeSingle();
  if (error) throw new Error(`nodes lookup failed: ${error.message}`);
  if (!data) throw new FatalStepError(`node ${nodeId} no longer exists`);
  return data;
}

async function updateNode(supabase, nodeId, patch, guards = {}) {
  let q = supabase.from("nodes").update(patch).eq("node_id", nodeId);
  for (const [col, val] of Object.entries(guards)) q = q.eq(col, val);
  const { data, error } = await q.select("node_id").maybeSingle();
  if (error) throw new Error(`nodes update failed: ${error.message}`);
  return !!data;
}

// ---------------------------------------------------------------- steps --

const done = (detail = {}) => ({ done: true, detail });
const wait = (seconds, detail = {}) => ({ waitSeconds: seconds, detail });

const CREATE_NODE_HANDLERS = {
  async CREATE_INSTANCE({ supabase, env, providers }, op, node) {
    if (node.provider_instance_id && node.ip_address) {
      return done({ providerInstanceId: node.provider_instance_id });
    }
    const adapter = providers(op.detail.provider, env);

    // Adopt a server an earlier attempt created but never recorded.
    const existing = await adapter.findInstanceByNodeId(node.node_id);
    if (existing) {
      await updateNode(supabase, node.node_id, {
        provider_instance_id: existing.providerInstanceId,
        ip_address: existing.ipAddress,
      });
      return done({ providerInstanceId: existing.providerInstanceId, adopted: true });
    }

    if (node.lifecycle_state !== "PROVISIONING") {
      throw new FatalStepError(`node is ${node.lifecycle_state}, not PROVISIONING`);
    }

    // Mint the token immediately before the one create call that embeds it.
    // Its hash is stored first: if the create then succeeds but its response
    // is lost, the next attempt adopts that server (above) and the token
    // baked into it still matches. A fresh token is only ever minted when
    // no server exists, so no running server can hold a stale one.
    const enrollmentToken = generateHexSecret();
    const stored = await updateNode(
      supabase,
      node.node_id,
      {
        enrollment_token_hash: await sha256Hex(enrollmentToken),
        enrollment_token_expires_at: new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS).toISOString(),
      },
      { lifecycle_state: "PROVISIONING" }
    );
    if (!stored) throw new FatalStepError("node left PROVISIONING while creating its server");

    const userData = buildNodeBootstrapUserData({
      workerUrl: env.SITE_URL,
      nodeId: node.node_id,
      role: node.role,
      hostname: node.hostname,
      enrollmentToken,
      singboxVpnVersion: env.FLEET_SINGBOX_VPN_VERSION,
      singboxVpnRepo: env.FLEET_SINGBOX_VPN_REPO,
      realityHandshakeServer: env.FLEET_REALITY_HANDSHAKE_SERVER,
    });
    const instance = await adapter.createInstance({
      nodeId: node.node_id,
      region: op.detail.region,
      userData,
    });
    await updateNode(supabase, node.node_id, {
      provider_instance_id: instance.providerInstanceId,
      ip_address: instance.ipAddress,
    });
    return done({ providerInstanceId: instance.providerInstanceId, region: instance.region });
  },

  async PUBLISH_DNS({ supabase, env, dns }, _op, node) {
    if (!node.ip_address) throw new Error("node has no IP address yet");
    const { recordId } = await dns(env).upsertAddressRecord({
      name: node.hostname,
      type: "A",
      content: String(node.ip_address),
    });
    if (node.dns_record_id !== recordId) {
      await updateNode(supabase, node.node_id, { dns_record_id: recordId });
    }
    return done({ hostname: node.hostname });
  },

  async AWAIT_ENROLLMENT(_ctx, _op, node) {
    if (node.lifecycle_state === "PROVISIONING") return wait(30, { waiting: "enrollment" });
    if (node.lifecycle_state === "WARMING_UP" || node.lifecycle_state === "READY") return done();
    throw new FatalStepError(`node entered ${node.lifecycle_state} before enrolling`);
  },

  async AWAIT_BOOTSTRAP(_ctx, _op, node) {
    if (node.lifecycle_state !== "WARMING_UP" && node.lifecycle_state !== "READY") {
      throw new FatalStepError(`node entered ${node.lifecycle_state} during bootstrap`);
    }
    if (node.bootstrap_stage === "COMPLETE" && node.bootstrap_status === "OK") return done();
    // A FAILED stage is not fatal here: the node's bootstrap unit retries on
    // its own. The operation deadline bounds how long we keep waiting.
    return wait(30, {
      stage: node.bootstrap_stage ?? null,
      status: node.bootstrap_status ?? null,
      message: node.bootstrap_message ?? null,
    });
  },

  async VERIFY_READINESS({ probe }, _op, node, step) {
    if (node.lifecycle_state === "READY") return done({ alreadyReady: true });
    if (node.lifecycle_state !== "WARMING_UP") {
      throw new FatalStepError(`node entered ${node.lifecycle_state} during readiness checks`);
    }
    const heartbeatFresh =
      node.last_seen_at && Date.now() - new Date(node.last_seen_at).getTime() < HEARTBEAT_FRESH_MS;
    const result = await probe(node.hostname);
    const ok = heartbeatFresh && result.ok;
    const passes = ok ? (step.detail?.consecutivePasses ?? 0) + 1 : 0;
    const detail = { consecutivePasses: passes, heartbeatFresh: !!heartbeatFresh, checks: result.checks };
    if (passes >= READINESS_CONSECUTIVE_PASSES) return done(detail);
    return wait(READINESS_PROBE_INTERVAL_S, detail);
  },

  async MARK_READY({ supabase }, _op, node) {
    if (node.lifecycle_state === "READY") return done();
    if (!canTransitionLifecycle(node.lifecycle_state, "READY")) {
      throw new FatalStepError(`cannot mark ${node.lifecycle_state} node READY`);
    }
    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: "READY", lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: node.lifecycle_state }
    );
    if (!moved) throw new Error("node lifecycle changed concurrently");
    return done();
  },
};

export const DEFAULT_REPLACE_MAX_WAIT_HOURS = 72;
export const DRAIN_POLL_INTERVAL_S = 300;
// Buffer beyond CREATE_NODE_DEADLINE_MS + the drain wait, so the operation's
// own outer deadline_at is a pure safety net -- DRAIN_OLD_NODE's own
// drainDeadline is what actually forces the drain through on schedule.
const REPLACE_DEADLINE_BUFFER_MS = 60 * 60 * 1000;

export const CANARY_OBSERVATION_MS = 2 * 60 * 60 * 1000; // 2 hours
export const CANARY_SESSION_CAP = 10;

export const REPLACE_NODE_STEPS = [...CREATE_NODE_STEPS, "AWAIT_CANARY", "DRAIN_OLD_NODE", "RETIRE_OLD_NODE"];

const REPLACE_NODE_HANDLERS = {
  ...CREATE_NODE_HANDLERS,

  // Overrides CREATE_NODE_HANDLERS.MARK_READY: when this operation is
  // canary-mode, the new node goes to CANARY instead of READY, and
  // AWAIT_CANARY (below) is what eventually promotes it. Non-canary
  // REPLACE_NODE operations (detail.canary is false/absent) behave
  // identically to CREATE_NODE_HANDLERS.MARK_READY.
  async MARK_READY({ supabase }, op, node) {
    if (node.lifecycle_state === "READY" || node.lifecycle_state === "CANARY") return done();
    const targetState = op.detail.canary ? "CANARY" : "READY";
    if (!canTransitionLifecycle(node.lifecycle_state, targetState)) {
      throw new FatalStepError(`cannot mark ${node.lifecycle_state} node ${targetState}`);
    }
    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: targetState, lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: node.lifecycle_state }
    );
    if (!moved) throw new Error("node lifecycle changed concurrently");
    return done();
  },

  async AWAIT_CANARY({ supabase }, op, node) {
    if (!op.detail.canary || node.lifecycle_state === "READY") return done();
    if (node.lifecycle_state !== "CANARY") {
      throw new FatalStepError(`node entered ${node.lifecycle_state} during canary observation`);
    }

    const failures = node.consecutive_probe_failures ?? 0;
    // A node that goes completely dark (agent/VM crashed) never sends
    // another heartbeat, so it never earns another probe result and
    // consecutive_probe_failures can sit frozen below FAILURE_THRESHOLD
    // forever -- without this check a silent canary would be promoted to
    // READY on the window elapsing alone, and the old node would then be
    // drained out from under live traffic for a replacement that isn't
    // actually reachable. Phase 8's own SILENCE_ELIGIBLE_STATES doesn't
    // cover CANARY (only READY/DEGRADED), so this is CANARY's own silence
    // check, not a call into isNodeSilent().
    const silent =
      node.last_seen_at &&
      Date.now() - new Date(node.last_seen_at).getTime() > HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER;
    if (silent || failures >= FAILURE_THRESHOLD) {
      const moved = await updateNode(
        supabase,
        node.node_id,
        { lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString(), failed_reason: "CANARY_ABORT" },
        { lifecycle_state: "CANARY" }
      );
      if (!moved) throw new Error("node lifecycle changed concurrently");
      throw new FatalStepError(
        silent
          ? `node ${node.node_id} went silent during canary observation`
          : `node ${node.node_id} failed canary observation (${failures} consecutive probe failures)`
      );
    }

    const elapsedMs = Date.now() - new Date(node.lifecycle_state_changed_at).getTime();
    if (elapsedMs < CANARY_OBSERVATION_MS) {
      return wait(DRAIN_POLL_INTERVAL_S, {});
    }

    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: "READY", lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: "CANARY" }
    );
    if (!moved) throw new Error("node lifecycle changed concurrently");
    return done();
  },

  async DRAIN_OLD_NODE({ supabase }, op, _newNode, step) {
    const oldNodeId = op.detail.oldNodeId;
    const { data: oldNode, error } = await supabase
      .from("nodes")
      .select("node_id, lifecycle_state")
      .eq("node_id", oldNodeId)
      .maybeSingle();
    if (error) throw new Error(`nodes lookup failed: ${error.message}`);
    if (!oldNode) throw new FatalStepError(`old node ${oldNodeId} no longer exists`);

    let drainDeadline = step.detail?.drainDeadline;

    if (!drainDeadline) {
      // Idempotent: a retry after a crash between this write and the
      // drainDeadline being persisted below must not re-attempt a
      // DRAINING->DRAINING transition (not a valid edge) and fail the
      // whole operation -- only transition if not already there.
      if (oldNode.lifecycle_state !== "DRAINING") {
        if (!canTransitionLifecycle(oldNode.lifecycle_state, "DRAINING")) {
          throw new FatalStepError(`old node ${oldNodeId} is ${oldNode.lifecycle_state}, cannot drain`);
        }
        const moved = await updateNode(
          supabase,
          oldNodeId,
          { lifecycle_state: "DRAINING", lifecycle_state_changed_at: new Date().toISOString() },
          { lifecycle_state: oldNode.lifecycle_state }
        );
        if (!moved) throw new FatalStepError(`old node ${oldNodeId} lifecycle changed concurrently`);
      }

      const maxWaitHours = op.detail.maxWaitHours ?? DEFAULT_REPLACE_MAX_WAIT_HOURS;
      drainDeadline = new Date(Date.now() + maxWaitHours * 60 * 60 * 1000).toISOString();
      // Wait one poll cycle before the first assignment check -- keeps this
      // tick's job to just the transition, and (as a side effect) keeps it
      // from cascading straight into RETIRE_OLD_NODE within the same
      // advanceOperation() call that finished MARK_READY for the new node.
      return wait(DRAIN_POLL_INTERVAL_S, { drainDeadline });
    }

    // Once draining, the old node must stay draining -- if it moved
    // elsewhere concurrently (e.g. an admin quarantined it), fail loudly
    // rather than silently overwrite that action.
    if (oldNode.lifecycle_state !== "DRAINING") {
      throw new FatalStepError(
        `old node ${oldNodeId} lifecycle changed concurrently (now ${oldNode.lifecycle_state})`
      );
    }

    const { data: assignments, error: assignError } = await supabase
      .from("device_node_assignments")
      .select("device_id")
      .eq("node_id", oldNodeId);
    if (assignError) throw new Error(`device_node_assignments lookup failed: ${assignError.message}`);
    const remaining = (assignments ?? []).length;

    if (remaining === 0) return done({ drainDeadline, remaining: 0 });
    if (Date.now() > new Date(drainDeadline).getTime()) {
      return done({ drainDeadline, remaining, forced: true });
    }
    return wait(DRAIN_POLL_INTERVAL_S, { drainDeadline, remaining });
  },

  // F-06: dangling DNS / subdomain takeover. The DNS record for a node's
  // hostname MUST be gone before its Hetzner instance is destroyed --
  // otherwise the hostname keeps resolving to an IP nobody controls until
  // Hetzner reassigns it to a different customer, who can then stand up a
  // TLS-terminating service on our own hostname (a classic subdomain
  // takeover). This step order (DNS delete -> verify -> RETIRED -> destroy
  // instance) is not incidental: RETIRED itself now requires
  // dns_removed_at to be set (see revoke_node_key_and_transition and the
  // admin lifecycle route), so a node can never reach the terminal state
  // with a still-published record.
  async RETIRE_OLD_NODE({ supabase, providers, dns, env }, op) {
    const oldNodeId = op.detail.oldNodeId;
    const { data: oldNode, error } = await supabase
      .from("nodes")
      .select("node_id, lifecycle_state, provider, provider_instance_id, hostname, dns_record_id, dns_removed_at")
      .eq("node_id", oldNodeId)
      .maybeSingle();
    if (error) throw new Error(`nodes lookup failed: ${error.message}`);
    if (!oldNode) throw new FatalStepError(`old node ${oldNodeId} no longer exists`);

    if (!["DRAINING", "RETIRED"].includes(oldNode.lifecycle_state)) {
      throw new FatalStepError(`old node ${oldNodeId} is ${oldNode.lifecycle_state}, expected DRAINING or RETIRED`);
    }

    // F-20/B-03: RETIRE is already assignment-gated in this saga --
    // DRAIN_OLD_NODE (above) only ever completes ("done") once
    // device_node_assignments for oldNodeId is empty, OR once its own
    // maxWaitHours deadline has explicitly passed (an admin-configured,
    // audited timeout the operator chose when starting this REPLACE_NODE
    // operation -- see startReplaceNodeOperation's maxWaitHours param).
    // Regression test: "forces the drain through once drainDeadline
    // passes, even with assignments remaining, and actually retires"
    // (functions/lib/__tests__/fleet-operations.test.js) confirms this
    // step is never reached with live assignments except via that explicit,
    // pre-audited forced-timeout path. The *other* place a RETIRE can be
    // requested -- a direct admin action outside this saga -- has its own
    // separate, explicit assignment refusal; see
    // functions/api/admin/nodes/[id]/lifecycle.js.

    if (!oldNode.dns_removed_at) {
      const adapter = dns(env);
      await adapter.deleteRecord({ recordId: oldNode.dns_record_id, name: oldNode.hostname, type: "A" });
      // Verify by lookup rather than trusting a 200/404 from delete alone
      // -- Cloudflare's own eventual-consistency window means a record can
      // still resolve for a short time after a successful delete API call.
      const stillThere = await adapter.recordExists({ name: oldNode.hostname, type: "A" });
      if (stillThere) {
        return wait(DRAIN_POLL_INTERVAL_S, { retrying: "dns_delete_verification" });
      }
      await updateNode(supabase, oldNodeId, { dns_removed_at: new Date().toISOString() });
    }

    if (oldNode.lifecycle_state === "DRAINING") {
      const moved = await updateNode(
        supabase,
        oldNodeId,
        {
          lifecycle_state: "RETIRED",
          retired_at: new Date().toISOString(),
          lifecycle_state_changed_at: new Date().toISOString(),
        },
        { lifecycle_state: "DRAINING" }
      );
      if (!moved) throw new Error(`old node ${oldNodeId} lifecycle changed concurrently`);
    }

    // Re-attempt destroy even when this node was already RETIRED by an
    // earlier tick of THIS SAME operation: the idempotency_key
    // (REPLACE_NODE:<oldNodeId>) guarantees only this operation ever moves
    // this specific old node to RETIRED, so "already RETIRED" here can only
    // mean a prior tick's transition succeeded but destroyInstance then
    // threw (triggering a MAX_STEP_ATTEMPTS retry) -- never a genuinely
    // separate actor. destroyInstance is idempotent (404-as-success), so
    // re-calling it is always safe and never leaks an instance on retry.
    if (oldNode.provider_instance_id) {
      const adapter = providers(oldNode.provider, env);
      await adapter.destroyInstance({ providerInstanceId: oldNode.provider_instance_id });
    }
    return done({ retired: true });
  },
};

const HANDLERS = { CREATE_NODE: CREATE_NODE_HANDLERS, REPLACE_NODE: REPLACE_NODE_HANDLERS };

// ------------------------------------------------------------ creation --

/**
 * Registers a PROVISIONING node and its CREATE_NODE operation (plus steps)
 * atomically via register_node_create_operation(). Idempotent on nodeId:
 * the node primary key and the operation's idempotency_key both derive
 * from it, so a duplicate request fails cleanly with 23505.
 */
export async function startCreateNodeOperation(
  supabase,
  { nodeId, role, locationId, provider, region, hostname }
) {
  const { data: operation, error } = await supabase.rpc("register_node_create_operation", {
    p_node_id: nodeId,
    p_role: role,
    p_location_id: locationId,
    p_provider: provider,
    p_hostname: hostname,
    p_detail: { provider, region },
    p_steps: CREATE_NODE_STEPS,
    p_deadline_at: new Date(Date.now() + CREATE_NODE_DEADLINE_MS).toISOString(),
  });
  if (error) return { error };
  return { operation };
}

/**
 * Registers a PROVISIONING new node and its REPLACE_NODE operation (plus
 * steps) atomically via register_node_replace_operation(). Idempotent on
 * oldNodeId (not newNodeId): the operation's idempotency_key derives from
 * the OLD node, so a second replace attempt for the same old node fails
 * cleanly with 23505 regardless of what newNodeId it names.
 */
export async function startReplaceNodeOperation(
  supabase,
  {
    newNodeId,
    role,
    locationId,
    provider,
    region,
    hostname,
    oldNodeId,
    maxWaitHours = DEFAULT_REPLACE_MAX_WAIT_HOURS,
    canary = false,
  }
) {
  // Canary mode must budget the full observation window into the outer
  // deadline too, or a forced drain that only starts after AWAIT_CANARY's
  // window elapses can hit the outer deadline before DRAIN_OLD_NODE ever
  // gets to force through -- stranding the old node in DRAINING forever
  // with its provider instance never destroyed (final-review finding).
  const deadlineMs =
    CREATE_NODE_DEADLINE_MS +
    (canary ? CANARY_OBSERVATION_MS : 0) +
    maxWaitHours * 60 * 60 * 1000 +
    REPLACE_DEADLINE_BUFFER_MS;
  const { data: operation, error } = await supabase.rpc("register_node_replace_operation", {
    p_node_id: newNodeId,
    p_role: role,
    p_location_id: locationId,
    p_provider: provider,
    p_hostname: hostname,
    p_detail: { provider, region, canary },
    p_old_node_id: oldNodeId,
    p_max_wait_hours: maxWaitHours,
    p_steps: REPLACE_NODE_STEPS,
    p_deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
  });
  if (error) return { error };
  return { operation };
}

// ------------------------------------------------------------- engine --

async function finishOperation(supabase, op, status, lastError = null) {
  await supabase
    .from("fleet_operations")
    .update({ status, lease_until: null, last_error: lastError ? truncate(lastError) : null })
    .eq("id", op.id);
}

async function failNodeIfBooting(supabase, nodeId) {
  if (!nodeId) return;
  for (const from of ["PROVISIONING", "WARMING_UP", "CANARY"]) {
    await updateNode(
      supabase,
      nodeId,
      { lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString(), failed_reason: "BOOT_TIMEOUT" },
      { lifecycle_state: from }
    );
  }
}

/**
 * Advances one operation as far as it can go right now.
 *
 * @param {object} ctx { supabase, env, providers(name, env), dns(env), probe(hostname) }
 * @param {object} op  a fleet_operations row (already leased by the caller)
 * @returns {Promise<{ status: string, step?: string, waitSeconds?: number, error?: string }>}
 */
export async function advanceOperation(ctx, op) {
  const { supabase } = ctx;
  const handlers = HANDLERS[op.type];
  if (!handlers) {
    await finishOperation(supabase, op, "FAILED", `unknown operation type ${op.type}`);
    return { status: "FAILED", error: "unknown operation type" };
  }

  const { data: steps, error: stepsError } = await supabase
    .from("operation_steps")
    .select("id, step_index, name, status, attempts, detail")
    .eq("operation_id", op.id)
    .order("step_index", { ascending: true });
  if (stepsError) throw new Error(`operation_steps lookup failed: ${stepsError.message}`);

  if (op.deadline_at && new Date(op.deadline_at) < new Date()) {
    const current = steps.find((s) => s.status !== "COMPLETED");
    const message = `deadline exceeded${current ? ` at ${current.name}` : ""}`;
    if (current) {
      await supabase
        .from("operation_steps")
        .update({ status: "FAILED", error: message })
        .eq("id", current.id);
    }
    await finishOperation(supabase, op, "FAILED", message);
    await failNodeIfBooting(supabase, op.node_id);
    return { status: "FAILED", step: current?.name, error: message };
  }

  for (const step of steps) {
    if (step.status === "COMPLETED") continue;
    const handler = handlers[step.name];
    if (!handler) throw new Error(`no handler for step ${step.name}`);

    if (step.status === "PENDING") {
      await supabase
        .from("operation_steps")
        .update({ status: "RUNNING", started_at: new Date().toISOString() })
        .eq("id", step.id);
    }

    let outcome;
    try {
      const node = await loadNode(supabase, op.node_id);
      outcome = await handler(ctx, op, node, step);
    } catch (err) {
      const attempts = (step.attempts ?? 0) + 1;
      const fatal = err instanceof FatalStepError || attempts >= MAX_STEP_ATTEMPTS;
      const message = truncate(err.message);
      logEvent(fatal ? "error" : "warn", "fleet_operations.step_failed", {
        operation_id: op.id,
        operation_type: op.type,
        node_id: op.node_id,
        step: step.name,
        attempts,
        fatal,
        error: message,
      });
      if (DNS_STEPS.has(step.name)) {
        await raiseAlert(supabase, {
          kind: "dns_adapter_failed",
          severity: fatal ? "critical" : "warning",
          dedupKey: `dns-adapter:${op.node_id}:${step.name}`,
          nodeId: op.node_id,
          message: `fleet-operations: DNS step ${step.name} failed for node ${op.node_id} (attempt ${attempts}): ${message}`,
        });
      }
      await supabase
        .from("operation_steps")
        .update({ attempts, error: message, status: fatal ? "FAILED" : "RUNNING" })
        .eq("id", step.id);
      if (fatal) {
        await finishOperation(supabase, op, "FAILED", `${step.name}: ${message}`);
        await failNodeIfBooting(supabase, op.node_id);
        return { status: "FAILED", step: step.name, error: message };
      }
      const delay = backoffSeconds(attempts);
      await supabase
        .from("fleet_operations")
        .update({
          attempts: (op.attempts ?? 0) + 1,
          last_error: `${step.name}: ${message}`,
          next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
          lease_until: null,
        })
        .eq("id", op.id);
      return { status: "RUNNING", step: step.name, waitSeconds: delay, error: message };
    }

    if (outcome.done) {
      await supabase
        .from("operation_steps")
        .update({
          status: "COMPLETED",
          completed_at: new Date().toISOString(),
          detail: outcome.detail ?? {},
          error: null,
        })
        .eq("id", step.id);
      if (DNS_STEPS.has(step.name)) {
        await resolveAlert(supabase, `dns-adapter:${op.node_id}:${step.name}`);
      }
      continue;
    }

    await supabase.from("operation_steps").update({ detail: outcome.detail ?? {} }).eq("id", step.id);
    await supabase
      .from("fleet_operations")
      .update({
        next_attempt_at: new Date(Date.now() + outcome.waitSeconds * 1000).toISOString(),
        lease_until: null,
        last_error: null,
      })
      .eq("id", op.id);
    return { status: "RUNNING", step: step.name, waitSeconds: outcome.waitSeconds };
  }

  await finishOperation(supabase, op, "COMPLETED");
  return { status: "COMPLETED" };
}

// ------------------------------------------------------ F-20/B-03/C-12 --
// Make-before-break re-placement of legacy (non-scheduler) devices off
// FAILED/DRAINING nodes, driven from fleet-tick every minute independent of
// any explicit REPLACE_NODE operation -- a node can go FAILED with nobody
// ever starting a replace for it (spec's B-03).
//
// Two-step, resumed across ticks purely by re-reading current state (no
// separate saga/lease table -- this is a much smaller state machine than
// CREATE_NODE/REPLACE_NODE and each step's own idempotency_key already
// makes re-running it safe):
//   1. CREATE_USER on a replacement node (idempotency_key
//      `replace-legacy:<device>:create:<targetNode>`). Never touches the
//      assignment yet.
//   2. Once that identity is enabled, flip device_node_assignments to the
//      new node and enqueue DISABLE_USER on the old one.

async function pickReplacementNode(supabase, { excludeNodeId }) {
  const { data: nodes, error } = await supabase
    .from("nodes")
    .select("node_id, configured_users, max_sessions, lifecycle_state")
    .eq("role", "EXIT")
    .in("lifecycle_state", ["READY", "CANARY"])
    .neq("node_id", excludeNodeId);
  if (error) throw new Error(`nodes lookup failed: ${error.message}`);
  const candidates = (nodes ?? []).filter((n) => {
    const max =
      n.lifecycle_state === "CANARY" ? Math.min(n.max_sessions ?? Infinity, CANARY_SESSION_CAP) : n.max_sessions;
    if (max == null) return true;
    return (n.configured_users ?? 0) < max;
  });
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const loadA = a.configured_users ?? Infinity;
    const loadB = b.configured_users ?? Infinity;
    if (loadA !== loadB) return loadA - loadB;
    return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
  });
  return sorted[0].node_id;
}

async function reconcileOneFailedNodeDevice(supabase, { deviceId, oldNodeId }) {
  // A device whose entitlement already lapsed has nothing worth re-placing
  // -- the normal device-provisioning reconcile path (not this one) is what
  // eventually disables it everywhere.
  const { entitled } = await checkDeviceEntitlement(supabase, deviceId);
  if (!entitled) return null;

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id, user_id")
    .eq("id", deviceId)
    .maybeSingle();
  if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);
  if (!device) return null;

  const { data: identities, error: idError } = await supabase
    .from("vpn_accounts")
    .select("id, node_id, vpn_user_id, enabled")
    .eq("device_id", deviceId);
  if (idError) throw new Error(`vpn_accounts lookup failed: ${idError.message}`);

  const oldIdentity = (identities ?? []).find((i) => i.node_id === oldNodeId && i.enabled);
  if (!oldIdentity) return null; // nothing live on the bad node to move

  const targetNodeId = await pickReplacementNode(supabase, { excludeNodeId: oldNodeId });
  if (!targetNodeId) return { status: "no_replacement_available" };

  const existingOnTarget = (identities ?? []).find((i) => i.node_id === targetNodeId);

  if (existingOnTarget?.enabled) {
    // Step 1 already landed (a previous tick's CREATE_USER reported done) --
    // complete the switch now: assignment first, then disable the old
    // identity. The old node may itself be unreachable (that's often WHY
    // it's FAILED); DISABLE_USER simply never applies until/unless it
    // recovers, which is harmless -- the assignment has already moved.
    const { error: upsertError } = await supabase
      .from("device_node_assignments")
      .upsert({ device_id: deviceId, node_id: targetNodeId, hop: "EXIT" }, { onConflict: "device_id,hop" });
    if (upsertError) throw new Error(`device_node_assignments upsert failed: ${upsertError.message}`);

    const { error: jobError } = await supabase.from("provisioning_jobs").insert({
      idempotency_key: `replace-legacy:${deviceId}:disable:${oldNodeId}`,
      node_id: oldNodeId,
      job_type: "DISABLE_USER",
      vpn_account_id: oldIdentity.id,
      device_id: deviceId,
      payload: { vpn_user_id: oldIdentity.vpn_user_id, user_id: device.user_id, device_id: deviceId },
    });
    if (jobError && jobError.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${jobError.message}`);
    }
    return { status: "reassigned", targetNodeId };
  }

  // Step 1: create the replacement identity (make-before-break). The
  // assignment is not switched until a later tick observes this identity
  // enabled (above) -- so a device is never left pointing at a node with no
  // identity on it, and a crash between these two steps just means the
  // next tick re-checks and continues from wherever it left off.
  const { error: createError } = await supabase.from("provisioning_jobs").insert({
    idempotency_key: `replace-legacy:${deviceId}:create:${targetNodeId}`,
    node_id: targetNodeId,
    job_type: "CREATE_USER",
    vpn_account_id: null,
    device_id: deviceId,
    payload: { user_id: device.user_id, device_id: deviceId },
  });
  if (createError && createError.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${createError.message}`);
  }
  return { status: "creating", targetNodeId };
}

/**
 * @param {object} supabase service-role client
 * @returns {Promise<Array<{deviceId: string, oldNodeId: string, status: string, targetNodeId?: string}>>}
 */
export async function reconcileFailedNodeAssignments(supabase) {
  const { data: badNodes, error } = await supabase
    .from("nodes")
    .select("node_id")
    .in("lifecycle_state", ["FAILED", "DRAINING"]);
  if (error) throw new Error(`nodes lookup failed: ${error.message}`);

  const results = [];
  for (const node of badNodes ?? []) {
    const { data: assignments, error: assignError } = await supabase
      .from("device_node_assignments")
      .select("device_id")
      .eq("node_id", node.node_id)
      .eq("hop", "EXIT");
    if (assignError) throw new Error(`device_node_assignments lookup failed: ${assignError.message}`);
    for (const assignment of assignments ?? []) {
      try {
        const outcome = await reconcileOneFailedNodeDevice(supabase, {
          deviceId: assignment.device_id,
          oldNodeId: node.node_id,
        });
        if (outcome) results.push({ deviceId: assignment.device_id, oldNodeId: node.node_id, ...outcome });
      } catch (err) {
        console.error(
          "reconcileFailedNodeAssignments: device reconcile failed:",
          assignment.device_id,
          err.message
        );
      }
    }
  }
  return results;
}

// ---------------------------------------------------------- Phase 8/F-06/F-05 follow-up: abandoned-node cleanup --
//
// A FAILED node with nobody replacing it, or a RETIRED node whose provider
// instance was never destroyed (e.g. a direct admin RETIRED transition --
// only the REPLACE_NODE saga's RETIRE_OLD_NODE step ever calls
// destroyInstance today), was previously left running forever: "kept for
// inspection" in practice meant a billed VPS nobody was watching and,
// while still FAILED (not yet QUARANTINED/RETIRED), a credential
// node-auth.js still accepts. This saga reuses the exact same
// fleet_operations/operation_steps engine as CREATE_NODE/REPLACE_NODE --
// idempotent per step, resumable across ticks, and self-documenting via
// operation_steps.detail -- rather than inventing a separate cleanup/audit
// mechanism.
//
// CRITICAL SAFETY RULE (spec for this pass): a node with ANY live
// device_node_assignments row is never touched destructively, no matter
// how stale/degraded its health looks. VERIFY_ELIGIBLE below is the sole
// gate every later, destructive step depends on -- it must complete
// ("done") before REMOVE_DNS/REVOKE_AND_RETIRE/DESTROY_INSTANCE ever run,
// and it re-checks assignments (and lifecycle_state) fresh on every call,
// so a node that gains an assignment or recovers to READY between ticks
// aborts the whole operation rather than continuing on stale information.
export const CLEANUP_ABANDONED_NODE_STEPS = [
  "VERIFY_ELIGIBLE",
  "REMOVE_DNS",
  "REVOKE_AND_RETIRE",
  "DESTROY_INSTANCE",
];

// How long a node must have sat in FAILED before this sweep will touch it.
// Deliberately long: FAILED->READY is a normal, automated recovery edge
// (Phase 8 silence/probe recovery), and node-auto-replace.js already gets
// first crack at any FAILED node via AUTO_REPLACE_AFTER_FAILED_MS -- this
// cleanup exists for the ones nothing else is handling, not to race ahead
// of the fleet's own recovery/replace machinery.
export const CLEANUP_FAILED_STALE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_DEADLINE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_ASSIGNMENT_RECHECK_S = 3600;

async function countLiveAssignments(supabase, nodeId) {
  const { data, error } = await supabase.from("device_node_assignments").select("device_id").eq("node_id", nodeId);
  if (error) throw new Error(`device_node_assignments lookup failed: ${error.message}`);
  return (data ?? []).length;
}

const CLEANUP_ABANDONED_NODE_HANDLERS = {
  async VERIFY_ELIGIBLE({ supabase }, _op, node) {
    if (!["FAILED", "RETIRED"].includes(node.lifecycle_state)) {
      // The node recovered (or was moved by an admin) since this cleanup
      // was queued -- abort rather than act on stale eligibility. Fatal,
      // not a retry: nothing about this outcome changes on its own, and
      // silently continuing here is exactly the "destroy a node with a
      // live assignment" hazard this step exists to prevent.
      throw new FatalStepError(`node ${node.node_id} is ${node.lifecycle_state}, no longer eligible for cleanup`);
    }
    const remaining = await countLiveAssignments(supabase, node.node_id);
    if (remaining > 0) {
      // Never proceed to a destructive step while assignments remain,
      // however stale/degraded the node's health is. Unlike DRAIN_OLD_NODE
      // (which has an audited forced-timeout escape hatch for the explicit
      // REPLACE_NODE saga a human started), this sweep has none: it runs
      // unattended, so it only ever waits for reconcileFailedNodeAssignments
      // (or an admin) to actually clear the assignments, never forces
      // through on a timer.
      return wait(CLEANUP_ASSIGNMENT_RECHECK_S, { blocked: "live_assignments", remaining });
    }
    return done({ remaining: 0 });
  },

  // Mirrors RETIRE_OLD_NODE's DNS-removal step exactly (F-06): delete, then
  // verify by lookup rather than trusting delete's response alone.
  async REMOVE_DNS({ supabase, dns, env }, _op, node) {
    if (node.dns_removed_at) return done();
    if (!node.dns_record_id && !node.hostname) return done();
    const adapter = dns(env);
    await adapter.deleteRecord({ recordId: node.dns_record_id, name: node.hostname, type: "A" });
    const stillThere = await adapter.recordExists({ name: node.hostname, type: "A" });
    if (stillThere) {
      return wait(DRAIN_POLL_INTERVAL_S, { retrying: "dns_delete_verification" });
    }
    await updateNode(supabase, node.node_id, { dns_removed_at: new Date().toISOString() });
    return done();
  },

  // F-05: a FAILED node's credential is still accepted by node-auth.js --
  // only QUARANTINED/RETIRED are rejected. This step is what actually
  // revokes it for an abandoned FAILED node, by driving the SAME atomic
  // RPC the admin lifecycle route uses (key revocation + job cancellation +
  // lease-slot cleanup + route-directory bump, all one transaction).
  async REVOKE_AND_RETIRE({ supabase }, _op, node) {
    if (node.lifecycle_state === "RETIRED") {
      // Already RETIRED (e.g. a direct admin retirement predating this
      // cleanup). revoke_node_key_and_transition requires a state
      // transition to run, so a RETIRED row that -- defensively -- still
      // has a live credential (a row written before F-05, or any future
      // path that reaches RETIRED without going through the RPC) is
      // revoked directly here instead.
      if (node.revoked_at) return done({ already_revoked: true });
      await updateNode(supabase, node.node_id, { revoked_at: new Date().toISOString(), api_key_hash: null });
      return done({ revoked_defensively: true });
    }

    // dns_removed_at is already set by REMOVE_DNS above, so no override is
    // ever needed here.
    const { data: result, error } = await supabase.rpc("revoke_node_key_and_transition", {
      p_node_id: node.node_id,
      p_to_state: "RETIRED",
      p_expected_from_state: "FAILED",
    });
    if (error) throw new Error(`revoke_node_key_and_transition failed: ${error.message}`);
    if (result?.status === "stale") {
      throw new FatalStepError(`node ${node.node_id} lifecycle changed concurrently during cleanup`);
    }
    if (result?.status === "dns_not_removed") {
      // Should be unreachable (REMOVE_DNS ran first), but never silently
      // retry a destructive path on an assumption that turned out false.
      throw new FatalStepError(`node ${node.node_id}: dns_removed_at unexpectedly unset`);
    }
    return done({ jobsCancelled: result?.jobs_cancelled ?? 0, leaseSlotsDeleted: result?.lease_slots_deleted ?? 0 });
  },

  // Idempotent (destroyInstance treats 404 as success) and only reachable
  // once VERIFY_ELIGIBLE/REMOVE_DNS/REVOKE_AND_RETIRE have all completed --
  // the saga engine runs steps strictly in order, so this can never run
  // against a node that still has live assignments, a published DNS
  // record, or a live credential.
  async DESTROY_INSTANCE({ supabase, providers, env }, _op, node) {
    if (node.provider_instance_destroyed_at) return done({ already_destroyed: true });
    if (node.provider_instance_id) {
      const adapter = providers(node.provider, env);
      await adapter.destroyInstance({ providerInstanceId: node.provider_instance_id });
    }
    await updateNode(supabase, node.node_id, { provider_instance_destroyed_at: new Date().toISOString() });
    return done({ destroyed: !!node.provider_instance_id });
  },
};

HANDLERS.CLEANUP_ABANDONED_NODE = CLEANUP_ABANDONED_NODE_HANDLERS;

/**
 * Registers (or, idempotently, re-fetches) the CLEANUP_ABANDONED_NODE
 * operation for one node. Safe to call every sweep tick for the same
 * eligible node -- register_cleanup_operation() returns the existing
 * operation rather than erroring on a repeat call.
 */
export async function startCleanupAbandonedNodeOperation(supabase, { nodeId }) {
  const { data: operation, error } = await supabase.rpc("register_cleanup_operation", {
    p_node_id: nodeId,
    p_steps: CLEANUP_ABANDONED_NODE_STEPS,
    p_deadline_at: new Date(Date.now() + CLEANUP_DEADLINE_MS).toISOString(),
  });
  if (error) return { error };
  return { operation };
}

/**
 * Finds nodes eligible for the abandoned-node cleanup sweep: FAILED longer
 * than CLEANUP_FAILED_STALE_MS, or RETIRED with its provider instance not
 * yet confirmed destroyed. Used by both the dry-run report and the live
 * sweep (functions/lib/fleet-cleanup.js) -- the two must agree on exactly
 * which nodes are "eligible" or a dry-run report would lie about what a
 * live run will do.
 */
export async function findAbandonedNodeCandidates(supabase, { now = Date.now() } = {}) {
  const staleBefore = new Date(now - CLEANUP_FAILED_STALE_MS).toISOString();
  const { data: failedNodes, error: failedError } = await supabase
    .from("nodes")
    .select("node_id, lifecycle_state, lifecycle_state_changed_at, provider_instance_id, provider_instance_destroyed_at")
    .eq("lifecycle_state", "FAILED")
    .lt("lifecycle_state_changed_at", staleBefore);
  if (failedError) throw new Error(`nodes lookup failed: ${failedError.message}`);

  const { data: retiredNodes, error: retiredError } = await supabase
    .from("nodes")
    .select("node_id, lifecycle_state, lifecycle_state_changed_at, provider_instance_id, provider_instance_destroyed_at")
    .eq("lifecycle_state", "RETIRED")
    .not("provider_instance_id", "is", null)
    .is("provider_instance_destroyed_at", null);
  if (retiredError) throw new Error(`nodes lookup failed: ${retiredError.message}`);

  return [...(failedNodes ?? []), ...(retiredNodes ?? [])];
}
