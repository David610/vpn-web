/**
 * What must happen right after a node reports a new VPN identity created
 * (functions/api/agent/jobs/[id]/complete.js, CREATE_USER).
 *
 * - The device may have been revoked, or its member removed from the plan,
 *   while the CREATE_USER job was in flight. Nothing else would ever notice
 *   the brand-new identity, so disable it immediately -- a revoked device
 *   must never regain network access through a job that raced revocation.
 * - Otherwise this completes a make-before-break move
 *   (device-provisioning.js): the device's identities on OTHER nodes are
 *   disabled now that its identity on this node exists.
 */
export async function finalizeCreatedIdentity(supabaseAdmin, { identity, nodeId, userId }) {
  const { data: device, error: deviceError } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, user_id, status")
    .eq("id", identity.deviceId)
    .maybeSingle();
  if (deviceError) throw new Error(`devices lookup failed: ${deviceError.message}`);

  let stillEntitled = !!device && device.status !== "REVOKED";
  if (stillEntitled) {
    const { data: membership, error: memberError } = await supabaseAdmin
      .from("account_members")
      .select("user_id")
      .eq("account_id", device.account_id)
      .eq("user_id", device.user_id)
      .maybeSingle();
    if (memberError) throw new Error(`account_members lookup failed: ${memberError.message}`);
    stillEntitled = !!membership;
  }

  const disable = async (target, key) => {
    const { error } = await supabaseAdmin.from("provisioning_jobs").insert({
      idempotency_key: key,
      node_id: target.nodeId,
      job_type: "DISABLE_USER",
      vpn_account_id: target.id,
      device_id: identity.deviceId,
      payload: { vpn_user_id: target.vpnUserId, user_id: userId, device_id: identity.deviceId },
    });
    if (error && error.code !== "23505") {
      throw new Error(`provisioning_jobs insert failed: ${error.message}`);
    }
  };

  if (!stillEntitled) {
    await disable({ ...identity, nodeId }, `created-after-revoke:${identity.id}`);
    return { disabledNew: true, disabledOthers: 0 };
  }

  const { data: others, error: othersError } = await supabaseAdmin
    .from("vpn_accounts")
    .select("id, node_id, vpn_user_id, enabled")
    .eq("device_id", identity.deviceId)
    .eq("enabled", true);
  if (othersError) throw new Error(`vpn_accounts lookup failed: ${othersError.message}`);
  const stale = (others ?? []).filter((o) => o.id !== identity.id && o.node_id !== nodeId);
  for (const o of stale) {
    await disable(
      { id: o.id, nodeId: o.node_id, vpnUserId: o.vpn_user_id },
      `moved:${identity.id}:disable:${o.id}`
    );
  }
  return { disabledNew: false, disabledOthers: stale.length };
}

/**
 * For CREATE_USER jobs enqueued before devices were canonical (no
 * payload.device_id): the user's oldest device without an identity on this
 * node, creating a "Legacy device" if every device already has one.
 */
export async function resolveLegacyDeviceForJob(supabaseAdmin, userId, nodeId) {
  const { data: devices, error } = await supabaseAdmin
    .from("devices")
    .select("id, account_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`devices lookup failed: ${error.message}`);
  for (const d of devices ?? []) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("vpn_accounts")
      .select("id")
      .eq("device_id", d.id)
      .eq("node_id", nodeId)
      .maybeSingle();
    if (existingError) throw new Error(`vpn_accounts lookup failed: ${existingError.message}`);
    if (!existing) return d.id;
  }
  const { data: membership, error: memberError } = await supabaseAdmin
    .from("account_members")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw new Error(`account_members lookup failed: ${memberError.message}`);
  if (!membership) return null;
  const { data: created, error: createError } = await supabaseAdmin
    .from("devices")
    .insert({ account_id: membership.account_id, user_id: userId, name: "Legacy device", status: "ACTIVE" })
    .select("id")
    .single();
  if (createError) throw new Error(`devices insert failed: ${createError.message}`);
  return created.id;
}
