-- Phase 2.5: node-loaded acknowledgement and make-before-break route publication.
-- Rollout is fail-closed: even pre-existing targets are unpublished until the
-- node proves its current compatibility authorization projection live.
alter table public.logical_route_targets
  add column if not exists published boolean not null default false;

update public.logical_route_targets
set published = false;

alter table public.logical_route_targets
  drop constraint if exists logical_route_targets_published_requires_enabled;
alter table public.logical_route_targets
  add constraint logical_route_targets_published_requires_enabled
  check (not published or enabled);

alter table public.compatibility_authorizations
  add column if not exists loaded_at timestamptz;

create index if not exists compatibility_authorizations_readiness_idx
  on public.compatibility_authorizations(node_id, logical_route_id, revoked, valid_until, loaded_at);
-- Keep authorization projection synchronized with every desired route target.
-- A pending target receives credentials before it can become subscription-visible.
create or replace function public.reconcile_route_target_authorizations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.compatibility_authorizations
      set revoked = true, loaded_at = null, updated_at = now()
      where logical_route_id = old.route_id and node_id = old.node_id and revoked = false;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and (old.route_id, old.node_id) is distinct from (new.route_id, new.node_id) then
    update public.compatibility_authorizations
      set revoked = true, loaded_at = null, updated_at = now()
      where logical_route_id = old.route_id and node_id = old.node_id and revoked = false;
    new.published := false;
  end if;

  if new.enabled = false then
    new.published := false;
    update public.compatibility_authorizations
      set revoked = true, loaded_at = null, updated_at = now()
      where logical_route_id = new.route_id and node_id = new.node_id and revoked = false;
    return new;
  end if;
  insert into public.compatibility_authorizations(
      principal_id, credential_id, credential_class, logical_route_id, node_id,
      valid_from, valid_until, revoked, credential_ciphertext, credential_nonce,
      loaded_at, updated_at)
  select d.principal_id, c.credential_id, 'compatibility', new.route_id, new.node_id,
      c.valid_from, c.valid_until, false, c.credential_ciphertext, c.credential_nonce,
      null, now()
  from public.external_vpn_devices d
  join public.compatibility_credentials c on c.device_id = d.device_id
  where d.desired_route_id = new.route_id
    and d.revoked_at is null
    and c.revoked_at is null
    and c.valid_until > now()
  on conflict (node_id, credential_id) do update
  set principal_id = excluded.principal_id,
      credential_class = excluded.credential_class,
      logical_route_id = excluded.logical_route_id,
      valid_from = excluded.valid_from,
      valid_until = excluded.valid_until,
      revoked = false,
      credential_ciphertext = excluded.credential_ciphertext,
      credential_nonce = excluded.credential_nonce,
      loaded_at = case
        when public.compatibility_authorizations.credential_ciphertext = excluded.credential_ciphertext
         and public.compatibility_authorizations.credential_nonce = excluded.credential_nonce
        then public.compatibility_authorizations.loaded_at
        else null
      end,
      updated_at = now();
  return new;
end $$;
drop trigger if exists logical_route_target_authorization_reconcile
  on public.logical_route_targets;
create trigger logical_route_target_authorization_reconcile
before insert or update or delete on public.logical_route_targets
for each row execute function public.reconcile_route_target_authorizations();

-- Called only after vpn-admin has rendered, checked, atomically applied and
-- verified the credential set live. It also promotes pending route targets
-- only after every currently-active credential for that target is loaded.
create or replace function public.ack_compatibility_authorizations(
  p_node_id text,
  p_credential_ids text[]
) returns table(published_route_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_credential_ids), 0) > 4096 then
    raise exception 'authorization_ack_too_large';
  end if;

  update public.compatibility_authorizations
    set loaded_at = now(), updated_at = now()
    where node_id = p_node_id
      and credential_id = any(coalesce(p_credential_ids, array[]::text[]))
      and revoked = false
      and valid_from <= now()
      and valid_until > now();
  return query
  update public.logical_route_targets t
    set published = true
    where t.node_id = p_node_id
      and t.enabled = true
      and t.published = false
      and not exists (
        select 1
        from public.compatibility_authorizations a
        where a.node_id = t.node_id
          and a.logical_route_id = t.route_id
          and a.revoked = false
          and a.valid_from <= now()
          and a.valid_until > now()
          and a.loaded_at is null
      )
    returning t.route_id;
end $$;

revoke execute on function public.ack_compatibility_authorizations(text,text[])
  from public, anon, authenticated;
revoke execute on function public.reconcile_route_target_authorizations()
  from public, anon, authenticated;
-- Re-state rotation with the data-plane's exact 48-hour maximum overlap.
create or replace function public.rotate_compatibility_credential(
  p_device_id uuid, p_account_id uuid, p_credential_id text,
  p_ciphertext text, p_nonce text, p_valid_until timestamptz,
  p_overlap_seconds integer default 172800
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_device public.external_vpn_devices; v_overlap_until timestamptz;
begin
  if p_overlap_seconds < 3600 or p_overlap_seconds > 172800 then
    raise exception 'invalid_overlap';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || p_device_id::text, 0));
  select * into v_device from public.external_vpn_devices
    where device_id=p_device_id and account_id=p_account_id and revoked_at is null for update;
  if not found then return false; end if;
  v_overlap_until := now() + make_interval(secs => p_overlap_seconds);
  update public.compatibility_credentials set valid_until=least(valid_until,v_overlap_until)
    where device_id=p_device_id and revoked_at is null and valid_until>now();
  update public.compatibility_authorizations
    set valid_until=least(valid_until,v_overlap_until), updated_at=now()
    where principal_id=v_device.principal_id and revoked=false and valid_until>now();
  delete from public.compatibility_credentials
    where device_id=p_device_id and valid_until<=now();
  insert into public.compatibility_credentials(
      device_id,credential_id,credential_ciphertext,credential_nonce,
      valid_from,valid_until,publish_from)
    values(p_device_id,p_credential_id,p_ciphertext,p_nonce,now(),p_valid_until,now());
  insert into public.compatibility_authorizations(
      principal_id,credential_id,credential_class,logical_route_id,node_id,
      valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
    select v_device.principal_id,p_credential_id,'compatibility',
      v_device.desired_route_id,t.node_id,now(),p_valid_until,false,p_ciphertext,p_nonce
    from public.logical_route_targets t
    where t.route_id=v_device.desired_route_id and t.enabled;
  if not found then raise exception 'route_unavailable'; end if;
  return true;
end $$;

revoke execute on function public.rotate_compatibility_credential(
  uuid,uuid,text,text,text,timestamptz,integer)
  from public, anon, authenticated;