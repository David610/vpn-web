import { resolveNodeForUser } from "./resolve-node.js";
import {
  scheduleNodeForDevice,
  scheduleDoubleHopForDevice,
  scheduleAutoForDevice,
} from "./scheduler.js";
import {
  listAccountSubscriptions,
  loadDeviceEntitlements,
  pickSubscriptionWithRoom,
} from "./subscriptions.js";

/**
 * Device-canonical VPN provisioning: the ONE place that turns "this device,
 * with this entitlement" into provisioning jobs.
 *
 * Model: a device owns one VPN identity (vpn_accounts row: its own
 * vpn_user_id and credentials, never shared) per node it connects to -- the
 * DIRECT/AUTO exit, or the RELAY entry of a double-hop route. Everything
 * that used to act on "the user's account on node-1" now acts per device,
 * on whichever node each identity actually lives on.
 *
 * Placement:
 *   FEATURE_MULTI_NODE_SCHEDULING !== "true"  -> legacy: resolveNodeForUser()
 *   otherwise, from the device's connection profile (none => AUTO):
 *     DIRECT     scheduleNodeForDevice      (READY EXIT in the exit location)
 *     DOUBLE_HOP scheduleDoubleHopForDevice (identity on the RELAY)
 *     AUTO       scheduleAutoForDevice      (any allowed direct exit)
 *
 * Fail-closed, never an unauthorized fallback. When placement fails the
 * reason decides what happens to identities the device already has:
 *   POLICY    (profile disabled/foreign, path not allowed) -> disable them;
 *             the route they serve is no longer authorized.
 *   CAPACITY  (no healthy/available node right now) -> leave them as they
 *             are; cutting everyone off during an outage helps nobody, and
 *             failover moves them when a node is available.
 *
 * Moves are make-before-break: the identity on the new node is created
 * first; identities on other nodes are disabled only once it exists.
 */

/**
 * Hard ceiling on one account's active devices, whatever it pays for — a
 * guard against runaway device creation, not a product limit (capacity is
 * per subscription; see subscriptions.js).
 */
export const MAX_ACTIVE_DEVICES_PER_ACCOUNT = 60;

export function isFleetSchedulingEnabled(env) {
  return env?.FEATURE_MULTI_NODE_SCHEDULING === "true";
}

async function insertJob(supabaseAdmin, row) {
  const { error } = await supabaseAdmin.from("provisioning_jobs").insert(row);
  // 23505: same idempotency key (a redelivered event) or an in-flight
  // CREATE_USER for this (device, node) already exists -- both mean the
  // desired effect is already enqueued.
  if (error && error.code !== "23505") {
    throw new Error(`provisioning_jobs insert failed: ${error.message}`);
  }
}

export async function listDeviceIdentities(supabaseAdmin, deviceId) {
  const { data, error } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, node_id, vpn_user_id, enabled, user_id")
    .eq("device_id", deviceId);
  if (error) throw new Error(`vpn_accounts lookup failed: ${error.message}`);
  return data ?? [];
}

async function loadDeviceProfile(supabaseAdmin, device) {
  const { data: assignment, error } = await supabaseAdmin
    .from("device_profile_assignments")
    .select("profile_id")
    .eq("device_id", device.id)
    .maybeSingle();
  if (error) throw new Error(`device_profile_assignments lookup failed: ${error.message}`);
  if (!assignment) return null;
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("connection_profiles")
    .select(
      "id, account_id, enabled, routing_mode, preferred_entry_location_id, preferred_exit_location_id"
    )
    .eq("id", assignment.profile_id)
    .maybeSingle();
  if (profileError) throw new Error(`connection_profiles lookup failed: ${profileError.message}`);
  return profile;
}

async function hasEnabledPath(supabaseAdmin, entryLocationId, exitLocationId) {
  let q = supabaseAdmin
    .from("allowed_paths")
    .select("id")
    .eq("exit_location_id", exitLocationId)
    .eq("enabled", true);
  q = entryLocationId ? q.eq("entry_location_id", entryLocationId) : q.is("entry_location_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`allowed_paths lookup failed: ${error.message}`);
  return !!data;
}

const policy = (reason) => ({ ok: false, kind: "POLICY", reason });
const capacity = (reason) => ({ ok: false, kind: "CAPACITY", reason });

/**
 * Decides which node(s) a device uses. Persists sticky node assignments
 * (via the scheduler) but never enqueues jobs.
 *
 * @returns {Promise<{ok:true, mode:string, entryNodeId:string, exitNodeId:string|null}
 *   | {ok:false, kind:"POLICY"|"CAPACITY", reason:string}>}
 */
export async function placeDevice(supabaseAdmin, env, device, identities = []) {
  if (!isFleetSchedulingEnabled(env)) {
    const nodeId = resolveNodeForUser();
    return { ok: true, mode: "LEGACY", entryNodeId: nodeId, exitNodeId: nodeId };
  }

  const profile = await loadDeviceProfile(supabaseAdmin, device);
  if (profile && profile.account_id !== device.account_id) {
    return policy("assigned profile belongs to another account");
  }
  if (profile && !profile.enabled) return policy("assigned connection profile is disabled");
  const mode = profile?.routing_mode ?? "AUTO";

  if (mode === "DIRECT") {
    const exitLocationId = profile.preferred_exit_location_id;
    if (!(await hasEnabledPath(supabaseAdmin, null, exitLocationId))) {
      return policy("direct route to this location is not allowed");
    }
    const nodeId = await scheduleNodeForDevice(supabaseAdmin, { deviceId: device.id, exitLocationId });
    if (!nodeId) return capacity("no healthy exit node available in this location");
    return { ok: true, mode, entryNodeId: nodeId, exitNodeId: nodeId };
  }

  if (mode === "DOUBLE_HOP") {
    const entryLocationId = profile.preferred_entry_location_id;
    const exitLocationId = profile.preferred_exit_location_id;
    if (!(await hasEnabledPath(supabaseAdmin, entryLocationId, exitLocationId))) {
      return policy("this entry/exit route is not allowed");
    }
    const placed = await scheduleDoubleHopForDevice(supabaseAdmin, {
      deviceId: device.id,
      entryLocationId,
      exitLocationId,
    });
    if (!placed) return capacity("no healthy relay/exit pair available for this route");
    return { ok: true, mode, entryNodeId: placed.relayNodeId, exitNodeId: placed.exitNodeId };
  }

  // AUTO: prefer the node the device's enabled identity already lives on.
  const preferredNodeId = identities.find((i) => i.enabled)?.node_id ?? null;
  const nodeId = await scheduleAutoForDevice(supabaseAdmin, { deviceId: device.id, preferredNodeId });
  if (!nodeId) return capacity("no healthy exit node available in any allowed location");
  return { ok: true, mode: "AUTO", entryNodeId: nodeId, exitNodeId: nodeId };
}

async function recordPlacement(supabaseAdmin, deviceId, placement) {
  const { error } = await supabaseAdmin
    .from("devices")
    .update({
      placement_status: placement.ok ? "PLACED" : "UNSCHEDULABLE",
      placement_error: placement.ok ? null : placement.reason.slice(0, 300),
      placement_updated_at: new Date().toISOString(),
    })
    .eq("id", deviceId);
  if (error) throw new Error(`devices placement update failed: ${error.message}`);
}

async function disableIdentity(supabaseAdmin, device, identity, key) {
  await insertJob(supabaseAdmin, {
    idempotency_key: key,
    node_id: identity.node_id,
    job_type: "DISABLE_USER",
    vpn_account_id: identity.id,
    device_id: device.id,
    payload: { vpn_user_id: identity.vpn_user_id, user_id: device.user_id, device_id: device.id },
  });
}

/**
 * The CREATE_USER job payload for a device's identity on a node — pulled
 * out so vpn-authorize.js can enqueue an identical job when authorize-time
 * credential resolution finds no existing identity, without re-deriving
 * the clearExpiry/serviceExpiresAt branching here.
 */
export function buildCreateUserPayload(device, entitlement) {
  const payload = { user_id: device.user_id, device_id: device.id };
  if (!entitlement.clearExpiry) {
    if (!entitlement.serviceExpiresAt) throw new Error("finite entitlement is missing serviceExpiresAt");
    payload.expires_at = entitlement.serviceExpiresAt;
  }
  return payload;
}

/**
 * Reconciles ONE device's identities with its entitlement and placement.
 *
 * @param {object} args
 * @param {object} args.device  { id, account_id, user_id, status }
 * @param {object|null} args.entitlement  effective entitlement, or null
 * @param {string} args.idempotencyPrefix  unique per triggering event
 * @returns {Promise<{ action: string, placement?: object, hadIdentity: boolean,
 *   pendingFirstIdentity?: boolean }>}
 */
export async function reconcileDeviceProvisioning(
  supabaseAdmin,
  env,
  { device, entitlement, idempotencyPrefix }
) {
  const identities = await listDeviceIdentities(supabaseAdmin, device.id);
  const enabled = identities.filter((i) => i.enabled);
  // hadIdentity lets billing tell "never provisioned" from "not yet
  // processed"; pendingFirstIdentity marks a device with no working
  // identity anywhere whose first CREATE_USER is still in flight.
  const hadIdentity = identities.length > 0;

  if (device.status === "REVOKED" || !entitlement) {
    for (const identity of enabled) {
      await disableIdentity(supabaseAdmin, device, identity, `${idempotencyPrefix}:disable:${identity.id}`);
    }
    return { action: device.status === "REVOKED" ? "revoked" : "disabled", hadIdentity };
  }

  const placement = await placeDevice(supabaseAdmin, env, device, identities);
  await recordPlacement(supabaseAdmin, device.id, placement);

  if (!placement.ok) {
    if (placement.kind === "POLICY") {
      for (const identity of enabled) {
        await disableIdentity(supabaseAdmin, device, identity, `${idempotencyPrefix}:disable:${identity.id}`);
      }
    }
    return { action: "unschedulable", placement, hadIdentity };
  }

  const nodeId = placement.entryNodeId;
  const current = identities.find((i) => i.node_id === nodeId);

  if (!current) {
    const payload = buildCreateUserPayload(device, entitlement);
    await insertJob(supabaseAdmin, {
      idempotency_key: `${idempotencyPrefix}:create:${device.id}:${nodeId}`,
      node_id: nodeId,
      job_type: "CREATE_USER",
      vpn_account_id: null,
      device_id: device.id,
      payload,
    });
    // Old identities stay until this one exists (make-before-break); the
    // next reconcile after CREATE_USER completes disables them.
    return { action: "creating", placement, hadIdentity, pendingFirstIdentity: enabled.length === 0 };
  }

  const base = {
    node_id: nodeId,
    vpn_account_id: current.id,
    device_id: device.id,
  };
  if (entitlement.clearExpiry) {
    await insertJob(supabaseAdmin, {
      ...base,
      idempotency_key: `${idempotencyPrefix}:clear-expiry:${current.id}`,
      job_type: "CLEAR_EXPIRY",
      payload: { vpn_user_id: current.vpn_user_id },
    });
  } else {
    if (!entitlement.serviceExpiresAt) throw new Error("finite entitlement is missing serviceExpiresAt");
    await insertJob(supabaseAdmin, {
      ...base,
      idempotency_key: `${idempotencyPrefix}:expiry:${current.id}:${entitlement.serviceExpiresAt}`,
      job_type: "SET_EXPIRY",
      payload: { vpn_user_id: current.vpn_user_id, expires_at: entitlement.serviceExpiresAt },
    });
  }
  // Only a disabled identity needs ENABLE_USER (e.g. a late payment
  // recovering from dunning). Normal renewals stay one job per identity:
  // every job re-renders sing-box on its node.
  if (!current.enabled) {
    await insertJob(supabaseAdmin, {
      ...base,
      idempotency_key: `${idempotencyPrefix}:enable:${current.id}`,
      job_type: "ENABLE_USER",
      payload: { vpn_user_id: current.vpn_user_id, user_id: device.user_id, device_id: device.id },
    });
  }

  for (const stale of enabled.filter((i) => i.node_id !== nodeId)) {
    await disableIdentity(supabaseAdmin, device, stale, `${idempotencyPrefix}:disable-moved:${stale.id}`);
  }
  return { action: "active", placement, hadIdentity };
}

async function listAccountDevices(supabaseAdmin, accountId) {
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, user_id, status, created_at, subscription_id")
    .eq("account_id", accountId);
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  return data ?? [];
}

/**
 * Every current member must have at least one device so that subscribing
 * (or joining a plan) still yields a working configuration without extra
 * steps. Creates "My device" for members that have none -- never for a
 * member whose devices were all revoked (revocation must not be undone by
 * the next billing event).
 */
export async function ensureMemberDevices(supabaseAdmin, accountId, members, devices) {
  const created = [];
  const subscriptions = await listAccountSubscriptions(supabaseAdmin, accountId);
  for (const member of members) {
    if (devices.some((d) => d.user_id === member.userId)) continue;
    const room = pickSubscriptionWithRoom(subscriptions, devices.concat(created));
    const { data, error } = await supabaseAdmin
      .from("devices")
      .insert({
        account_id: accountId,
        user_id: member.userId,
        name: "My device",
        status: "ACTIVE",
        subscription_id: room?.id ?? null,
      })
      .select("id, account_id, user_id, status, created_at, subscription_id")
      .single();
    if (error) throw new Error(`devices insert failed: ${error.message}`);
    created.push(data);
  }
  return created;
}

/**
 * Account-level entry point used by billing, device changes and admin
 * grants: reconciles every device of the account.
 *
 * Entitlement is decided per device from the database, not from the caller:
 * a device is served while ITS subscription is live and it is within that
 * subscription's capacity (see subscriptions.js). So one subscription
 * lapsing disables only its own devices, and a device past capacity is
 * never served. `entitlement` only says whether the account has any access
 * at all, which decides whether a first device is created for it.
 */
export async function reconcileAccountProvisioning(
  supabaseAdmin,
  env,
  { accountId, members, entitlement, idempotencyPrefix }
) {
  let devices = await listAccountDevices(supabaseAdmin, accountId);
  if (entitlement) {
    devices = devices.concat(await ensureMemberDevices(supabaseAdmin, accountId, members, devices));
  }
  const memberIds = new Set(members.map((m) => m.userId));
  const entitlements = await loadDeviceEntitlements(supabaseAdmin, accountId, devices);
  const results = [];
  for (const device of devices) {
    const isMember = memberIds.has(device.user_id);
    const result = await reconcileDeviceProvisioning(supabaseAdmin, env, {
      device,
      entitlement: isMember ? entitlements.get(device.id) ?? null : null,
      idempotencyPrefix,
    });
    results.push({ deviceId: device.id, ...result });
  }
  return results;
}

/**
 * Revokes a device for real: marks it REVOKED and disables every VPN
 * identity it has, on whichever node each lives. Guarded on the status the
 * caller read, so a concurrent revoke/reactivation cannot be overwritten.
 *
 * @returns {Promise<{ revoked: boolean, disabled: number }>} revoked=false
 *   when the device's status changed concurrently.
 */
/**
 * `urgent` (abuse/admin: e.g. an owner removing another member or their
 * device) makes nodes rotate the device's lease slots immediately. Otherwise
 * they rotate at the node's next rotation batch boundary (at most
 * rotation_batch_interval later, never after the lease's expires_at),
 * because every rotation restarts sing-box and drops every open connection
 * on the node.
 */
export async function revokeDevice(supabaseAdmin, env, device, idempotencyPrefix, { urgent = false } = {}) {
  if (device.status !== "REVOKED") {
    const { data: updated, error } = await supabaseAdmin
      .from("devices")
      .update({ status: "REVOKED", revoked_at: new Date().toISOString() })
      .eq("id", device.id)
      .eq("status", device.status)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`devices update failed: ${error.message}`);
    if (!updated) return { revoked: false, disabled: 0 };
  }
  // ADR-0003: end every live ephemeral lease now; each node's agent rotates
  // the revoked slots (now if urgent, else at its next batch boundary).
  const { error: leaseError } = await supabaseAdmin.rpc("revoke_device_leases", { p_device_id: device.id, p_urgent: urgent });
  if (leaseError) throw new Error(`revoke_device_leases failed: ${leaseError.message}`);
  const identities = (await listDeviceIdentities(supabaseAdmin, device.id)).filter((i) => i.enabled);
  await reconcileDeviceProvisioning(supabaseAdmin, env, {
    device: { ...device, status: "REVOKED" },
    entitlement: null,
    idempotencyPrefix,
  });
  return { revoked: true, disabled: identities.length };
}
