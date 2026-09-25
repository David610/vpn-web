import { sha256Hex } from "./crypto.js";
import { generateHexSecret, ENROLLMENT_TOKEN_TTL_MS } from "./node-enrollment.js";
import { canTransitionLifecycle } from "./node-lifecycle.js";
import { buildNodeBootstrapUserData } from "./node-bootstrap.js";

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
      "node_id, role, lifecycle_state, hostname, provider, provider_instance_id, ip_address, dns_record_id, last_seen_at, bootstrap_stage, bootstrap_status, bootstrap_message"
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

const HANDLERS = { CREATE_NODE: CREATE_NODE_HANDLERS };

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

// ------------------------------------------------------------- engine --

async function finishOperation(supabase, op, status, lastError = null) {
  await supabase
    .from("fleet_operations")
    .update({ status, lease_until: null, last_error: lastError ? truncate(lastError) : null })
    .eq("id", op.id);
}

async function failNodeIfBooting(supabase, nodeId) {
  if (!nodeId) return;
  for (const from of ["PROVISIONING", "WARMING_UP"]) {
    await updateNode(
      supabase,
      nodeId,
      { lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString() },
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
