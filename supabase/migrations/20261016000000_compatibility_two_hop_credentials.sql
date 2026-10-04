-- Arcana: per-hop compatibility credentials.
--
-- create_external_vpn_device and rotate_compatibility_credential used to
-- accept exactly one credential and project it onto every enabled
-- logical_route_targets row for the route -- correct for a one-hop ('fast')
-- route (one target), but for a two-hop ('privacy_plus') route (two
-- targets, hop 1 entry + hop 2 exit) it authorized the SAME credential on
-- BOTH nodes identically. That is not "entry and exit use independently
-- scoped credential material" (ARCANA_PRODUCT_V1.md §4b) -- it is one
-- credential valid on two nodes. privacy_plus has stayed fail-closed in
-- client-capabilities.js throughout, so this was never reachable in
-- production, but the renderer-side half of this same gap (a malformed,
-- uncredentialed entry outbound) was fixed separately; this migration
-- fixes the credential-issuance half so the two line up.
--
-- Each compatibility_credentials row now belongs to exactly one hop. Both
-- RPCs take a `p_credentials` jsonb array of
-- {hop, credential_id, credential_ciphertext, credential_nonce} --
-- one element for a 'fast' route, two (hop 1 and hop 2) for 'privacy_plus'
-- -- instead of a single flat credential. Each element is authorized only
-- against the logical_route_targets row for its own hop, never both.

alter table public.compatibility_credentials
  add column hop integer not null default 1 check (hop in (1, 2));

-- The old index covered (device_id, valid_until desc) for the "at most two
-- live generations" scan; make it hop-aware so a privacy_plus device's two
-- simultaneous hops don't compete for the same two-generation budget.
drop index public.compatibility_credentials_device_valid_idx;
create index compatibility_credentials_device_hop_valid_idx
  on public.compatibility_credentials(device_id, hop, valid_until desc);

create or replace function public.limit_compatibility_credentials()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || new.device_id::text || ':' || new.hop::text, 0));
  if (select count(*) from public.compatibility_credentials c
      where c.device_id=new.device_id and c.hop=new.hop and c.revoked_at is null and c.valid_until > now()) >= 2 then
    raise exception 'compatibility_credential_limit';
  end if;
  return new;
end $$;

-- assign_compatibility_credential_generation (20261014000000_arcana_links_foundation.sql)
-- picked the device's single latest row by `device_id` alone to compute the
-- next `generation`/`rotated_from` -- for a privacy_plus device inserting
-- both hops together, that made hop 2's row look like a rotation of hop 1's
-- (wrong lineage: they are independent hops, not successive generations of
-- the same credential) and collided with the generation-uniqueness
-- constraint below once two hops needed their own "generation 1". Both are
-- now scoped per (device_id, hop), matching this migration's hop column.
alter table public.compatibility_credentials
  drop constraint compatibility_credentials_device_generation_unique;
alter table public.compatibility_credentials
  add constraint compatibility_credentials_device_hop_generation_unique unique (device_id, hop, generation);

create or replace function public.assign_compatibility_credential_generation()
returns trigger language plpgsql set search_path = '' as $$
declare v_previous public.compatibility_credentials;
begin
  if new.generation is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || new.device_id::text || ':' || new.hop::text, 0));
  select * into v_previous from public.compatibility_credentials
    where device_id=new.device_id and hop=new.hop order by generation desc limit 1;
  new.generation := coalesce(v_previous.generation,0)+1;
  new.rotated_from := v_previous.id;
  return new;
end $$;

-- `create or replace function` cannot change a function's argument list --
-- a different signature creates a second overload rather than replacing
-- the old one. Both RPCs' argument lists are changing (flat credential
-- fields -> one `p_credentials jsonb` array), so the old signatures must
-- be dropped explicitly first.
drop function if exists public.create_external_vpn_device(uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz);
drop function if exists public.rotate_compatibility_credential(uuid,uuid,text,text,text,timestamptz,integer);

-- Creates both the seat-bearing base device and its external extension under
-- one subscription row lock. Concurrent requests for the final seat serialize.
-- p_credentials: jsonb array of {hop, credential_id, credential_ciphertext,
-- credential_nonce}; must cover exactly the hops the route requires (one
-- element, hop 1, for 'fast'; two, hop 1 and hop 2, for 'privacy_plus') or
-- the whole call aborts -- a partially-credentialed device is never created.
create or replace function public.create_external_vpn_device(
  p_account_id uuid, p_user_id uuid, p_subscription_id bigint, p_name text,
  p_client_type text, p_principal_id text, p_token_hash text, p_route_id text,
  p_credentials jsonb, p_valid_until timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.subscriptions; v_device_id uuid; v_used integer; v_capacity integer;
  v_route public.logical_routes; v_cred jsonb; v_expected_hops integer[]; v_given_hops integer[];
begin
  perform pg_advisory_xact_lock(hashtextextended('external-seat:' || p_subscription_id::text, 0));
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found or v_sub.account_id <> p_account_id or v_sub.status not in ('active','trialing','past_due') then
    raise exception 'subscription_not_entitled';
  end if;
  v_capacity := 3 * (1 + greatest(coalesce(v_sub.extra_seats, 0), 0) / 3);
  select count(*) into v_used from public.devices
    where subscription_id = p_subscription_id and status = 'ACTIVE';
  if v_used >= v_capacity then raise exception 'seats_full'; end if;

  select * into v_route from public.logical_routes where id = p_route_id and enabled;
  if not found then raise exception 'route_unavailable'; end if;
  v_expected_hops := case when v_route.privacy_class = 'privacy_plus' then array[1,2] else array[1] end;
  select array_agg(distinct (c->>'hop')::integer order by (c->>'hop')::integer)
    into v_given_hops from jsonb_array_elements(p_credentials) c;
  if v_given_hops is distinct from v_expected_hops then raise exception 'credential_hop_mismatch'; end if;

  insert into public.devices(account_id,user_id,name,platform,status,subscription_id)
    values(p_account_id,p_user_id,p_name,'other','ACTIVE',p_subscription_id) returning id into v_device_id;
  insert into public.external_vpn_devices(device_id,account_id,client_type,principal_id,
      subscription_token_hash,desired_route_id)
    values(v_device_id,p_account_id,p_client_type,p_principal_id,p_token_hash,p_route_id);

  for v_cred in select * from jsonb_array_elements(p_credentials) loop
    insert into public.compatibility_credentials(device_id,hop,credential_id,credential_ciphertext,
        credential_nonce,valid_from,valid_until,publish_from)
      values(v_device_id,(v_cred->>'hop')::integer,v_cred->>'credential_id',
        v_cred->>'credential_ciphertext',v_cred->>'credential_nonce',now(),p_valid_until,now());
    insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,
        logical_route_id,node_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
      select p_principal_id,v_cred->>'credential_id','compatibility',p_route_id,t.node_id,now(),p_valid_until,
        false,v_cred->>'credential_ciphertext',v_cred->>'credential_nonce'
        from public.logical_route_targets t
        where t.route_id=p_route_id and t.enabled and t.hop=(v_cred->>'hop')::integer;
    if not found then raise exception 'route_unavailable'; end if;
  end loop;

  return v_device_id;
end $$;

-- p_credentials: same shape and same-hops-as-the-route requirement as
-- create_external_vpn_device above. Rotation always replaces every hop's
-- credential together -- one user action ("replace link") refreshes the
-- whole device, not one hop at a time. The overlap-trim/delete statements
-- below are intentionally NOT hop-filtered: trimming/deleting all of this
-- device's prior credentials regardless of hop is exactly the desired
-- "retire the old generation across every hop" behavior.
create or replace function public.rotate_compatibility_credential(
  p_device_id uuid, p_account_id uuid, p_credentials jsonb, p_valid_until timestamptz,
  p_overlap_seconds integer default 172800
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_device public.external_vpn_devices; v_overlap_until timestamptz; v_route public.logical_routes;
  v_cred jsonb; v_expected_hops integer[]; v_given_hops integer[];
begin
  if p_overlap_seconds < 3600 or p_overlap_seconds > 259200 then raise exception 'invalid_overlap'; end if;
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || p_device_id::text, 0));
  select * into v_device from public.external_vpn_devices
    where device_id=p_device_id and account_id=p_account_id and revoked_at is null for update;
  if not found then return false; end if;

  select * into v_route from public.logical_routes where id = v_device.desired_route_id and enabled;
  if not found then raise exception 'route_unavailable'; end if;
  v_expected_hops := case when v_route.privacy_class = 'privacy_plus' then array[1,2] else array[1] end;
  select array_agg(distinct (c->>'hop')::integer order by (c->>'hop')::integer)
    into v_given_hops from jsonb_array_elements(p_credentials) c;
  if v_given_hops is distinct from v_expected_hops then raise exception 'credential_hop_mismatch'; end if;

  v_overlap_until := now() + make_interval(secs => p_overlap_seconds);
  update public.compatibility_credentials set valid_until=least(valid_until,v_overlap_until)
    where device_id=p_device_id and revoked_at is null and valid_until>now();
  update public.compatibility_authorizations set valid_until=least(valid_until,v_overlap_until),updated_at=now()
    where principal_id=v_device.principal_id and revoked=false and valid_until>now();
  delete from public.compatibility_credentials where device_id=p_device_id and valid_until<=now();

  for v_cred in select * from jsonb_array_elements(p_credentials) loop
    insert into public.compatibility_credentials(device_id,hop,credential_id,credential_ciphertext,
        credential_nonce,valid_from,valid_until,publish_from)
      values(p_device_id,(v_cred->>'hop')::integer,v_cred->>'credential_id',
        v_cred->>'credential_ciphertext',v_cred->>'credential_nonce',now(),p_valid_until,now());
    insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,
        logical_route_id,node_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
      select v_device.principal_id,v_cred->>'credential_id','compatibility',v_device.desired_route_id,t.node_id,
        now(),p_valid_until,false,v_cred->>'credential_ciphertext',v_cred->>'credential_nonce'
        from public.logical_route_targets t
        where t.route_id=v_device.desired_route_id and t.enabled and t.hop=(v_cred->>'hop')::integer;
    if not found then raise exception 'route_unavailable'; end if;
  end loop;

  return true;
end $$;

revoke execute on function public.create_external_vpn_device(uuid,uuid,bigint,text,text,text,text,text,jsonb,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.rotate_compatibility_credential(uuid,uuid,jsonb,timestamptz,integer)
  from public, anon, authenticated;

-- create_vpn_link_client's own signature is unchanged -- a Links client is
-- always client_type 'links' (bare connection URIs), which can never be
-- privacy_plus (functions/lib/client-capabilities.js), so it only ever
-- needs the one hop-1 credential it already took. It now wraps that single
-- credential into the one-element jsonb array create_external_vpn_device
-- requires, rather than forwarding flat fields that no longer exist.
create or replace function public.create_vpn_link_client(
  p_link_id uuid, p_account_id uuid, p_user_id uuid, p_subscription_id bigint,
  p_name text, p_client_type text, p_idempotency_key text, p_principal_id text,
  p_token_hash text, p_credential_id text, p_credential_ciphertext text,
  p_credential_nonce text, p_valid_until timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_link public.vpn_links; v_device_id uuid; v_existing uuid;
begin
  select * into v_link from public.vpn_links
    where id=p_link_id and account_id=p_account_id for update;
  if not found or v_link.status <> 'active' then raise exception 'link_not_active'; end if;
  if not exists(select 1 from public.account_members
      where account_id=p_account_id and user_id=p_user_id) then
    raise exception 'user_not_in_account';
  end if;

  select device_id into v_existing from public.external_vpn_devices
    where link_id=p_link_id and idempotency_key=p_idempotency_key;
  if found then return v_existing; end if;

  if (select count(*) from public.external_vpn_devices
      where link_id=p_link_id and revoked_at is null) >= v_link.max_clients then
    raise exception 'link_capacity_full';
  end if;

  v_device_id := public.create_external_vpn_device(
    p_account_id,p_user_id,p_subscription_id,p_name,p_client_type,p_principal_id,
    p_token_hash,v_link.desired_route_id,
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id',p_credential_id,
      'credential_ciphertext',p_credential_ciphertext,'credential_nonce',p_credential_nonce)),
    p_valid_until);
  update public.external_vpn_devices set link_id=p_link_id,idempotency_key=p_idempotency_key
    where device_id=v_device_id;
  return v_device_id;
end $$;
