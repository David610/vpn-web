/**
 * In-memory model of the ADR-0003 lease-pool RPCs
 * (supabase/migrations/20260929000000_ephemeral_lease_pool.sql), for the
 * fake Supabase client. It mirrors the SQL's decisions -- replay before
 * rate limit, rate limit before selection, select every hop before writing
 * anything -- so the JS glue is tested against the same outcomes. The SQL
 * itself is exercised against a real Postgres in
 * supabase/tests/ephemeral_lease_pool.sql.
 */
const nowMs = () => Date.now();

export function leaseRouteSlots(args, tables) {
  const leases = tables.vpn_leases;
  const slots = tables.node_lease_slots;
  const now = nowMs();

  if (args.p_idempotency_key) {
    const existing = leases.find((l) => l.idempotency_key === args.p_idempotency_key);
    if (existing) {
      if (existing.device_id !== args.p_device_id || existing.route_id !== args.p_route_id) {
        return { data: { status: "conflict" }, error: null };
      }
      if (!existing.revoked_at && new Date(existing.expires_at).getTime() > now) {
        const hops = existing.hops.map((h) =>
          slots.find(
            (s) =>
              s.node_id === h.node_id && s.slot === h.slot && s.generation === h.generation &&
              s.lease_id === existing.id && s.state === "leased"
          )
        );
        if (hops.every(Boolean)) {
          return {
            data: { status: "ok", replay: true, lease_id: existing.id, expires_at: existing.expires_at, hops: hops.map(publicHop) },
            error: null,
          };
        }
      }
      existing.idempotency_key = null;
    }
  }

  const windowStart = now - args.p_window_seconds * 1000;
  const recent = (key, value) => leases.filter((l) => l[key] === value && new Date(l.created_at).getTime() > windowStart).length;
  if (recent("device_id", args.p_device_id) >= args.p_device_limit || recent("account_id", args.p_account_id) >= args.p_account_limit) {
    return { data: { status: "rate_limited", retry_after_seconds: args.p_window_seconds }, error: null };
  }

  const minValid = now + args.p_min_remaining_seconds * 1000;
  const chosen = [];
  for (const nodeId of args.p_node_ids) {
    const slot = slots
      .filter((s) => s.node_id === nodeId && s.state === "active" && new Date(s.valid_until).getTime() >= minValid && !chosen.includes(s))
      .sort((a, b) => new Date(b.valid_until) - new Date(a.valid_until))[0];
    if (!slot) return { data: { status: "exhausted", node_id: nodeId }, error: null };
    chosen.push(slot);
  }

  const id = `lease-${leases.length + 1}`;
  const expires = new Date(Math.min(...chosen.map((s) => new Date(s.valid_until).getTime()))).toISOString();
  for (const s of chosen) {
    s.state = "leased";
    s.lease_id = id;
  }
  leases.push({
    id,
    idempotency_key: args.p_idempotency_key,
    device_id: args.p_device_id,
    account_id: args.p_account_id,
    route_id: args.p_route_id,
    hops: chosen.map((s) => ({ node_id: s.node_id, slot: s.slot, generation: s.generation })),
    expires_at: expires,
    revoked_at: null,
    created_at: new Date(now).toISOString(),
  });
  return { data: { status: "ok", replay: false, lease_id: id, expires_at: expires, hops: chosen.map(publicHop) }, error: null };
}

function publicHop(s) {
  return {
    node_id: s.node_id,
    slot: s.slot,
    generation: s.generation,
    credential_ciphertext: s.credential_ciphertext,
    credential_nonce: s.credential_nonce,
  };
}

export function agentSyncLeaseSlots(args, tables) {
  const slots = tables.node_lease_slots;
  const need = [];
  const seen = new Set();
  for (const item of args.p_slots) {
    seen.add(item.slot);
    const row = slots.find((s) => s.node_id === args.p_node_id && s.slot === item.slot);
    if (row && row.generation >= item.generation) continue;
    if (!item.credential_ciphertext) {
      need.push(item.slot);
      continue;
    }
    const next = {
      node_id: args.p_node_id,
      slot: item.slot,
      generation: item.generation,
      valid_until: item.valid_until,
      credential_ciphertext: item.credential_ciphertext,
      credential_nonce: item.credential_nonce,
      state: "active",
      lease_id: null,
    };
    if (row) Object.assign(row, next);
    else slots.push(next);
  }
  tables.node_lease_slots = slots.filter((s) => s.node_id !== args.p_node_id || seen.has(s.slot));
  return {
    data: {
      as_of: new Date().toISOString(),
      need_secret: need,
      slots: tables.node_lease_slots
        .filter((s) => s.node_id === args.p_node_id)
        .sort((a, b) => a.slot - b.slot)
        .map((s) => ({ slot: s.slot, generation: s.generation, state: s.state })),
    },
    error: null,
  };
}

export function revokeDeviceLeases(args, tables) {
  const now = nowMs();
  let count = 0;
  for (const lease of tables.vpn_leases) {
    if (lease.device_id !== args.p_device_id || lease.revoked_at || new Date(lease.expires_at).getTime() <= now) continue;
    lease.revoked_at = new Date(now).toISOString();
    count += 1;
    for (const s of tables.node_lease_slots) if (s.lease_id === lease.id && s.state === "leased") s.state = "revoked";
  }
  return { data: count, error: null };
}
