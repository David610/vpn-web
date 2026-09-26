-- ADR-0003: ephemeral managed authorization (Sub-project B2).
--
-- /v1/vpn/authorize stops handing out long-lived vpn_accounts identities.
-- Instead every node's provisioning agent keeps a small, bounded pool of
-- pseudonymous credential slots (VLESS uuid + Hysteria2 password), applied
-- to its live sing-box config BEFORE they are reported here. Each slot
-- generation carries a node-chosen hard expiry (valid_until) that the node
-- enforces locally (vpn-admin renders expired users out of the sing-box
-- config; the agent's sweeper rotates the secret) whether or not this
-- control plane is reachable. authorize leases one slot per hop, all hops
-- in one transaction or none, and the lease ends exactly at the earliest
-- hop's valid_until -- a real, server-side end, not an advisory TTL.
--
-- sing-box 1.14.1 cannot change users at runtime: every rotation restarts it
-- and drops every open connection on the node. So (ADR-0003 "Bounding
-- disruption"): re-authorizing the same route while the lease is live
-- RENEWS it -- same slots, same credentials, later expires_at, which the
-- node adopts as a config-neutral store change (no restart) -- and nodes
-- batch non-urgent rotations onto a grid (node_lease_policy). Revocations
-- are non-urgent unless flagged urgent (abuse/admin).
--
-- Secrets are stored AES-GCM encrypted (functions/lib/crypto.js, the same
-- VPN_SECRETS_ENCRYPTION_KEY as vpn_secrets); nothing in these tables
-- names an email, account, subscription or Stripe object. Slots are keyed
-- by (node_id, slot) only; the lease row is what links a device to slots,
-- and it is service-role only.
--
-- Additive only.

create table public.node_lease_slots (
  node_id text not null references public.nodes (node_id) on delete cascade,
  slot integer not null check (slot >= 0 and slot < 4096),
  generation bigint not null check (generation > 0),
  valid_until timestamptz not null,
  credential_ciphertext text not null,
  credential_nonce text not null,
  -- active: applied live on the node (observed) and never leased.
  -- leased: handed to exactly one lease; never handed out again.
  -- revoked: lease revoked; the node rotates it on its next sync.
  state text not null default 'active' check (state in ('active', 'leased', 'revoked')),
  lease_id uuid,
  -- Renewal: the lease holding this generation was extended to this time.
  -- The node adopts it (floored to its grid, capped at its lifetime), so the
  -- node-enforced end never exceeds it.
  extend_to timestamptz,
  -- Revocation that the node must apply now rather than at its next batch.
  urgent boolean not null default false,
  observed_at timestamptz not null default now(),
  primary key (node_id, slot)
);

create index node_lease_slots_leasable_idx
  on public.node_lease_slots (node_id, valid_until desc)
  where state = 'active';

create table public.vpn_leases (
  id uuid primary key default extensions.gen_random_uuid(),
  idempotency_key text,
  device_id uuid not null references public.devices (id) on delete cascade,
  account_id uuid not null,
  route_id text not null,
  -- [{node_id, slot, generation}] in hop order. No secrets.
  hops jsonb not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index vpn_leases_idempotency_key_idx
  on public.vpn_leases (idempotency_key) where idempotency_key is not null;
create index vpn_leases_device_created_idx on public.vpn_leases (device_id, created_at desc);
create index vpn_leases_account_created_idx on public.vpn_leases (account_id, created_at desc);

-- Per-node (not per-lease) Hysteria2 salamander obfuscation password,
-- reported by the node's agent, AES-GCM encrypted. The managed client
-- needs it for hysteria2 hops whose route declares hysteria2_obfs_type.
create table public.node_transport_secrets (
  node_id text primary key references public.nodes (node_id) on delete cascade,
  hysteria2_obfs_ciphertext text,
  hysteria2_obfs_nonce text,
  updated_at timestamptz not null default now()
);

-- Each node's rotation grid and slot lifetime, as reported by its agent.
-- Renewal targets are computed on this grid and within this lifetime, so the
-- expires_at authorize returns is exactly what the node will enforce.
create table public.node_lease_policy (
  node_id text primary key references public.nodes (node_id) on delete cascade,
  rotation_batch_interval_secs integer not null check (rotation_batch_interval_secs between 60 and 3600),
  slot_lifetime_secs integer not null check (slot_lifetime_secs between 900 and 7200),
  updated_at timestamptz not null default now()
);

alter table public.node_lease_policy enable row level security;
revoke all on public.node_lease_policy from anon, authenticated;
alter table public.node_transport_secrets enable row level security;
revoke all on public.node_transport_secrets from anon, authenticated;
alter table public.node_lease_slots enable row level security;
alter table public.vpn_leases enable row level security;
revoke all on public.node_lease_slots from anon, authenticated;
revoke all on public.vpn_leases from anon, authenticated;

-- Leases one active slot on every node in p_node_ids (hop order), or none.
--
-- Renewal: if the device already holds a live lease on this route (not
-- revoked, every slot still leased by it at the same generation) with at
-- least p_renew_min_lead_seconds left, no slot is consumed: the lease is
-- extended in place to T = min over hops of
-- floor((now + least(p_renew_seconds, node lifetime)) / node grid) * grid,
-- written to each slot's extend_to and to the lease's expires_at (never
-- shortened), and the SAME credentials are returned. Renewals do not count
-- toward the rate limit (they create no lease row).
--
-- Returns jsonb {status, ...}:
--   ok            {lease_id, expires_at, replay, renewed, hops:[{node_id, slot, generation,
--                  credential_ciphertext, credential_nonce}]}
--   rate_limited  {retry_after_seconds}
--   exhausted     {node_id}   -- nothing was written
--   conflict      -- idempotency key reused for a different route/device
--   device_inactive -- the device is not ACTIVE (revoked concurrently)
create or replace function public.lease_route_slots(
  p_idempotency_key text,
  p_device_id uuid,
  p_account_id uuid,
  p_route_id text,
  p_node_ids text[],
  p_min_remaining_seconds integer,
  p_device_limit integer,
  p_account_limit integer,
  p_window_seconds integer,
  p_renew_seconds integer default 1800,
  p_renew_min_lead_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.vpn_leases;
  v_node text;
  v_slot public.node_lease_slots;
  v_chosen public.node_lease_slots[] := '{}';
  v_hops jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_expires timestamptz;
  v_lease_id uuid;
  v_count integer;
  v_target timestamptz;
  v_hop_target timestamptz;
  v_grid integer;
  v_life integer;
  i integer;
begin
  if p_node_ids is null or cardinality(p_node_ids) < 1 or cardinality(p_node_ids) > 2 then
    raise exception 'lease_route_slots: 1 or 2 hops required';
  end if;

  -- Serialize concurrent authorizes of the same device so the rate limit
  -- and idempotency checks below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('vpn_lease:' || p_device_id::text, 0));

  -- Re-check the device under the lock revoke_device_leases also takes. The
  -- caller checked it too, but a revocation landing between that check and
  -- this call would otherwise let a just-revoked device mint (or renew, or
  -- replay) a lease that revoke_device_leases never saw.
  if not exists (select 1 from public.devices d where d.id = p_device_id and d.status = 'ACTIVE') then
    return jsonb_build_object('status', 'device_inactive');
  end if;

  if p_idempotency_key is not null then
    select * into v_existing from public.vpn_leases where idempotency_key = p_idempotency_key;
    if found then
      if v_existing.device_id <> p_device_id or v_existing.route_id <> p_route_id then
        return jsonb_build_object('status', 'conflict');
      end if;
      if v_existing.revoked_at is null and v_existing.expires_at > now() then
        for i in 0 .. jsonb_array_length(v_existing.hops) - 1 loop
          select * into v_slot from public.node_lease_slots s
           where s.node_id = v_existing.hops -> i ->> 'node_id'
             and s.slot = (v_existing.hops -> i ->> 'slot')::integer
             and s.generation = (v_existing.hops -> i ->> 'generation')::bigint
             and s.lease_id = v_existing.id and s.state = 'leased';
          if not found then
            -- Slot rotated underneath the lease: the lease is dead.
            v_out := null;
            exit;
          end if;
          v_out := v_out || jsonb_build_array(jsonb_build_object(
            'node_id', v_slot.node_id, 'slot', v_slot.slot, 'generation', v_slot.generation,
            'credential_ciphertext', v_slot.credential_ciphertext,
            'credential_nonce', v_slot.credential_nonce));
        end loop;
        if v_out is not null then
          return jsonb_build_object('status', 'ok', 'replay', true, 'renewed', false,
            'lease_id', v_existing.id, 'expires_at', v_existing.expires_at, 'hops', v_out);
        end if;
        v_out := '[]'::jsonb;
      end if;
      -- Expired/revoked/dead: release the key so this retry gets a fresh lease.
      update public.vpn_leases set idempotency_key = null where id = v_existing.id;
    end if;
  end if;

  -- Renewal of this device's live lease on this route (see header).
  select * into v_existing from public.vpn_leases l
   where l.device_id = p_device_id and l.route_id = p_route_id and l.revoked_at is null
     and l.expires_at > now() + make_interval(secs => p_renew_min_lead_seconds)
   order by l.expires_at desc
   limit 1
   for update;
  if found then
    v_out := '[]'::jsonb;
    v_target := null;
    for i in 0 .. jsonb_array_length(v_existing.hops) - 1 loop
      select * into v_slot from public.node_lease_slots s
       where s.node_id = v_existing.hops -> i ->> 'node_id'
         and s.slot = (v_existing.hops -> i ->> 'slot')::integer
         and s.generation = (v_existing.hops -> i ->> 'generation')::bigint
         and s.lease_id = v_existing.id and s.state = 'leased'
       for update;
      if not found then
        v_out := null;
        exit;
      end if;
      select coalesce(p.rotation_batch_interval_secs, 600), coalesce(p.slot_lifetime_secs, 1800)
        into v_grid, v_life
        from (select 1) one left join public.node_lease_policy p on p.node_id = v_slot.node_id;
      v_hop_target := to_timestamp(
        floor(extract(epoch from now() + make_interval(secs => least(p_renew_seconds, v_life))) / v_grid) * v_grid);
      v_target := least(coalesce(v_target, v_hop_target), v_hop_target);
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'node_id', v_slot.node_id, 'slot', v_slot.slot, 'generation', v_slot.generation,
        'credential_ciphertext', v_slot.credential_ciphertext,
        'credential_nonce', v_slot.credential_nonce));
    end loop;
    if v_out is not null then
      if v_target > v_existing.expires_at then
        update public.vpn_leases set expires_at = v_target where id = v_existing.id;
        update public.node_lease_slots s set extend_to = v_target
          from jsonb_array_elements(v_existing.hops) h
         where s.node_id = h ->> 'node_id' and s.slot = (h ->> 'slot')::integer
           and s.generation = (h ->> 'generation')::bigint and s.lease_id = v_existing.id;
      else
        v_target := v_existing.expires_at;
      end if;
      if p_idempotency_key is not null then
        update public.vpn_leases set idempotency_key = p_idempotency_key where id = v_existing.id;
      end if;
      return jsonb_build_object('status', 'ok', 'replay', false, 'renewed', true,
        'lease_id', v_existing.id, 'expires_at', v_target, 'hops', v_out);
    end if;
    v_out := '[]'::jsonb;
  end if;

  select count(*) into v_count from public.vpn_leases
   where device_id = p_device_id and created_at > now() - make_interval(secs => p_window_seconds);
  if v_count >= p_device_limit then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', p_window_seconds);
  end if;
  select count(*) into v_count from public.vpn_leases
   where account_id = p_account_id and created_at > now() - make_interval(secs => p_window_seconds);
  if v_count >= p_account_limit then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', p_window_seconds);
  end if;

  -- Pick every hop first; write nothing unless all hops have a slot.
  foreach v_node in array p_node_ids loop
    select * into v_slot from public.node_lease_slots s
     where s.node_id = v_node
       and s.state = 'active'
       and s.valid_until >= now() + make_interval(secs => p_min_remaining_seconds)
       and not exists (select 1 from unnest(v_chosen) c where c.node_id = s.node_id and c.slot = s.slot)
     order by s.valid_until desc
     limit 1
     for update skip locked;
    if not found then
      return jsonb_build_object('status', 'exhausted', 'node_id', v_node);
    end if;
    v_chosen := v_chosen || v_slot;
  end loop;

  select min(c.valid_until) into v_expires from unnest(v_chosen) c;
  v_lease_id := extensions.gen_random_uuid();

  for i in 1 .. cardinality(v_chosen) loop
    v_hops := v_hops || jsonb_build_array(jsonb_build_object(
      'node_id', v_chosen[i].node_id, 'slot', v_chosen[i].slot, 'generation', v_chosen[i].generation));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'node_id', v_chosen[i].node_id, 'slot', v_chosen[i].slot, 'generation', v_chosen[i].generation,
      'credential_ciphertext', v_chosen[i].credential_ciphertext,
      'credential_nonce', v_chosen[i].credential_nonce));
    update public.node_lease_slots
       set state = 'leased', lease_id = v_lease_id
     where node_id = v_chosen[i].node_id and slot = v_chosen[i].slot
       and generation = v_chosen[i].generation;
  end loop;

  insert into public.vpn_leases (id, idempotency_key, device_id, account_id, route_id, hops, expires_at)
  values (v_lease_id, p_idempotency_key, p_device_id, p_account_id, p_route_id, v_hops, v_expires);

  return jsonb_build_object('status', 'ok', 'replay', false, 'renewed', false,
    'lease_id', v_lease_id, 'expires_at', v_expires, 'hops', v_out);
end;
$$;

-- Node-side reconciliation. p_slots is the agent's full local pool:
-- [{slot, generation, valid_until, credential_ciphertext?, credential_nonce?}].
-- The agent reports a generation only AFTER vpn-admin applied it live, so
-- a newly reported generation becomes 'active' (leasable) immediately.
-- p_policy {rotation_batch_interval_secs, slot_lifetime_secs} (optional)
-- is recorded for renewal targets. For a generation already stored, a later
-- valid_until reported by the node (an adopted renewal) is recorded.
-- Returns {as_of, slots:[{slot, generation, state, urgent, extend_to}], need_secret:[slot]}.
create or replace function public.agent_sync_lease_slots(p_node_id text, p_slots jsonb, p_policy jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_row public.node_lease_slots;
  v_need jsonb := '[]'::jsonb;
  v_slots integer[] := '{}';
begin
  if jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) > 4096 then
    raise exception 'agent_sync_lease_slots: slots must be an array of at most 4096';
  end if;

  if p_policy is not null then
    insert into public.node_lease_policy (node_id, rotation_batch_interval_secs, slot_lifetime_secs, updated_at)
    values (p_node_id, (p_policy ->> 'rotation_batch_interval_secs')::integer,
            (p_policy ->> 'slot_lifetime_secs')::integer, now())
    on conflict (node_id) do update
      set rotation_batch_interval_secs = excluded.rotation_batch_interval_secs,
          slot_lifetime_secs = excluded.slot_lifetime_secs, updated_at = now();
  end if;

  for v_item in select * from jsonb_array_elements(p_slots) loop
    v_slots := v_slots || (v_item ->> 'slot')::integer;
    select * into v_row from public.node_lease_slots
     where node_id = p_node_id and slot = (v_item ->> 'slot')::integer
     for update;
    if found and v_row.generation = (v_item ->> 'generation')::bigint then
      if (v_item ->> 'valid_until')::timestamptz > v_row.valid_until then
        update public.node_lease_slots set valid_until = (v_item ->> 'valid_until')::timestamptz,
               observed_at = now()
         where node_id = p_node_id and slot = v_row.slot;
      end if;
      continue;
    end if;
    if found and v_row.generation > (v_item ->> 'generation')::bigint then
      -- Never go backwards (a stale agent snapshot must not resurrect a
      -- rotated secret as leasable).
      continue;
    end if;
    if coalesce(v_item ->> 'credential_ciphertext', '') = '' then
      v_need := v_need || to_jsonb((v_item ->> 'slot')::integer);
      continue;
    end if;
    insert into public.node_lease_slots
      (node_id, slot, generation, valid_until, credential_ciphertext, credential_nonce,
       state, lease_id, observed_at)
    values (p_node_id, (v_item ->> 'slot')::integer, (v_item ->> 'generation')::bigint,
       (v_item ->> 'valid_until')::timestamptz, v_item ->> 'credential_ciphertext',
       v_item ->> 'credential_nonce', 'active', null, now())
    on conflict (node_id, slot) do update
      set generation = excluded.generation,
          valid_until = excluded.valid_until,
          credential_ciphertext = excluded.credential_ciphertext,
          credential_nonce = excluded.credential_nonce,
          state = 'active', lease_id = null, extend_to = null, urgent = false,
          observed_at = now();
  end loop;

  -- Pool shrank on the node: forget slots it no longer has.
  delete from public.node_lease_slots
   where node_id = p_node_id and not (slot = any (v_slots));

  return jsonb_build_object(
    'as_of', now(),
    'need_secret', v_need,
    'slots', coalesce((select jsonb_agg(jsonb_build_object(
        'slot', s.slot, 'generation', s.generation, 'state', s.state,
        'urgent', s.urgent, 'extend_to', s.extend_to) order by s.slot)
      from public.node_lease_slots s where s.node_id = p_node_id), '[]'::jsonb));
end;
$$;

-- Revokes every live lease of a device (device revoked, entitlement lost,
-- operator action). The affected slots are marked 'revoked'; each node's
-- agent rotates them -- immediately if p_urgent (abuse/admin), otherwise at
-- its next rotation batch boundary (at most rotation_batch_interval later,
-- and never after the lease's expires_at) -- which is what actually makes
-- the credential stop working. Returns the number of leases revoked.
create or replace function public.revoke_device_leases(p_device_id uuid, p_urgent boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Same per-device lock as lease_route_slots: a lease being minted right
  -- now either commits first (and is revoked below) or sees the device
  -- REVOKED (the caller flips devices.status before calling this).
  perform pg_advisory_xact_lock(hashtextextended('vpn_lease:' || p_device_id::text, 0));
  with revoked as (
    update public.vpn_leases set revoked_at = now()
     where device_id = p_device_id and revoked_at is null and expires_at > now()
    returning id
  ), slots as (
    update public.node_lease_slots s set state = 'revoked', urgent = coalesce(p_urgent, false)
      from revoked r where s.lease_id = r.id and s.state = 'leased'
    returning 1
  )
  select count(*) into v_count from revoked;
  return v_count;
end;
$$;

revoke execute on function public.lease_route_slots(text, uuid, uuid, text, text[], integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.agent_sync_lease_slots(text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.revoke_device_leases(uuid, boolean) from public, anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;
