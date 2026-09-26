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

  // Mirrors the SQL's in-lock device re-check (a device revoked between the
  // caller's check and the RPC gets no lease, renewal or replay).
  const device = (tables.devices ?? []).find((d) => d.id === args.p_device_id);
  if (device && device.status !== "ACTIVE") return { data: { status: "device_inactive" }, error: null };

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
            data: { status: "ok", replay: true, renewed: false, lease_id: existing.id, expires_at: existing.expires_at, hops: hops.map(publicHop) },
            error: null,
          };
        }
      }
      existing.idempotency_key = null;
    }
  }

  // Renewal: extend the device's live lease on this route in place.
  const renewSeconds = args.p_renew_seconds ?? 1800;
  const minLead = (args.p_renew_min_lead_seconds ?? 60) * 1000;
  const live = leases
    .filter(
      (l) => l.device_id === args.p_device_id && l.route_id === args.p_route_id && !l.revoked_at &&
        new Date(l.expires_at).getTime() > now + minLead
    )
    .sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0];
  if (live) {
    const held = live.hops.map((h) =>
      slots.find(
        (s) => s.node_id === h.node_id && s.slot === h.slot && s.generation === h.generation && s.lease_id === live.id && s.state === "leased"
      )
    );
    if (held.every(Boolean)) {
      const policies = tables.node_lease_policy ?? [];
      const target = Math.min(
        ...held.map((s) => {
          const p = policies.find((x) => x.node_id === s.node_id);
          const grid = (p?.rotation_batch_interval_secs ?? 600) * 1000;
          const life = (p?.slot_lifetime_secs ?? 1800) * 1000;
          return Math.floor((now + Math.min(renewSeconds * 1000, life)) / grid) * grid;
        })
      );
      if (target > new Date(live.expires_at).getTime()) {
        live.expires_at = new Date(target).toISOString();
        for (const s of held) s.extend_to = live.expires_at;
      }
      if (args.p_idempotency_key) live.idempotency_key = args.p_idempotency_key;
      return {
        data: { status: "ok", replay: false, renewed: true, lease_id: live.id, expires_at: live.expires_at, hops: held.map(publicHop) },
        error: null,
      };
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
  return { data: { status: "ok", replay: false, renewed: false, lease_id: id, expires_at: expires, hops: chosen.map(publicHop) }, error: null };
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
  if (args.p_policy) {
    tables.node_lease_policy = (tables.node_lease_policy ?? []).filter((p) => p.node_id !== args.p_node_id);
    tables.node_lease_policy.push({ node_id: args.p_node_id, ...args.p_policy });
  }
  for (const item of args.p_slots) {
    seen.add(item.slot);
    const row = slots.find((s) => s.node_id === args.p_node_id && s.slot === item.slot);
    if (row && row.generation === item.generation && new Date(item.valid_until) > new Date(row.valid_until)) {
      row.valid_until = item.valid_until;
    }
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
      extend_to: null,
      urgent: false,
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
        .map((s) => ({ slot: s.slot, generation: s.generation, state: s.state, urgent: s.urgent ?? false, extend_to: s.extend_to ?? null })),
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
    for (const s of tables.node_lease_slots) {
      if (s.lease_id === lease.id && s.state === "leased") {
        s.state = "revoked";
        s.urgent = args.p_urgent === true;
      }
    }
  }
  return { data: count, error: null };
}
