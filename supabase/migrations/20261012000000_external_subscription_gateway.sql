-- Arcana Phase 2: external VPN devices and compatibility authorizations.
-- Account linkage stops at external_vpn_devices. Rows projected to nodes in
-- compatibility_authorizations contain opaque principal/credential/route data
-- only and are not foreign-keyed to an account, user, subscription, or device.

create table public.logical_routes (
  id text primary key check (id ~ '^route_[a-z0-9_]{3,60}$'),
  region text not null check (region ~ '^[a-z0-9-]{2,24}$'),
  privacy_class text not null check (privacy_class in ('fast', 'privacy_plus')),
  display_name text not null check (char_length(display_name) between 1 and 80),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (region, privacy_class)
);

create table public.logical_route_targets (
  route_id text not null references public.logical_routes(id) on delete cascade,
  hop integer not null check (hop in (1, 2)),
  node_id text not null references public.nodes(node_id) on delete restrict,
  priority integer not null default 100,
  enabled boolean not null default true,
  primary key (route_id, hop, node_id)
);

create table public.external_vpn_devices (
  device_id uuid primary key references public.devices(id) on delete cascade,
  account_id uuid not null references public.customer_accounts(id) on delete cascade,
  client_type text not null check (client_type in ('hiddify','shadowrocket','incy','singbox','xray','links')),
  principal_id text not null unique check (principal_id ~ '^ext_[A-Za-z0-9_-]{32,80}$'),
  subscription_token_hash text not null unique check (subscription_token_hash ~ '^[0-9a-f]{64}$'),
  desired_route_id text not null references public.logical_routes(id) on delete restrict,
  capability_version text,
  last_subscription_fetch_at timestamptz,
  subscription_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.compatibility_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id uuid not null references public.external_vpn_devices(device_id) on delete cascade,
  credential_id text not null unique check (credential_id ~ '^cred_[A-Za-z0-9_-]{32,80}$'),
  credential_ciphertext text not null,
  credential_nonce text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  publish_from timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (valid_until > valid_from),
  check (publish_from >= valid_from and publish_from < valid_until)
);

-- No device can ever have a third non-revoked generation. Rotation first
-- retires an expired generation, then inserts B while A remains bounded.
create index compatibility_credentials_device_valid_idx
  on public.compatibility_credentials(device_id, valid_until desc);

create function public.limit_compatibility_credentials()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || new.device_id::text, 0));
  if (select count(*) from public.compatibility_credentials c
      where c.device_id=new.device_id and c.revoked_at is null and c.valid_until > now()) >= 2 then
    raise exception 'compatibility_credential_limit';
  end if;
  return new;
end $$;
create trigger compatibility_credentials_limit before insert on public.compatibility_credentials
  for each row execute function public.limit_compatibility_credentials();

create table public.compatibility_authorizations (
  principal_id text not null,
  credential_id text not null,
  credential_class text not null check (credential_class = 'compatibility'),
  logical_route_id text not null,
  node_id text not null references public.nodes(node_id) on delete cascade,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  revoked boolean not null default false,
  credential_ciphertext text not null,
  credential_nonce text not null,
  updated_at timestamptz not null default now(),
  primary key (node_id, credential_id),
  check (principal_id ~ '^ext_[A-Za-z0-9_-]{32,80}$'),
  check (credential_id ~ '^cred_[A-Za-z0-9_-]{32,80}$')
);

alter table public.logical_routes enable row level security;
alter table public.logical_route_targets enable row level security;
alter table public.external_vpn_devices enable row level security;
alter table public.compatibility_credentials enable row level security;
alter table public.compatibility_authorizations enable row level security;
revoke all on public.logical_routes, public.logical_route_targets,
  public.external_vpn_devices, public.compatibility_credentials,
  public.compatibility_authorizations from anon, authenticated;

-- Creates both the seat-bearing base device and its external extension under
-- one subscription row lock. Concurrent requests for the final seat serialize.
create or replace function public.create_external_vpn_device(
  p_account_id uuid, p_user_id uuid, p_subscription_id bigint, p_name text,
  p_client_type text, p_principal_id text, p_token_hash text, p_route_id text,
  p_credential_id text, p_credential_ciphertext text, p_credential_nonce text,
  p_valid_until timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_sub public.subscriptions; v_device_id uuid; v_used integer; v_capacity integer;
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
  insert into public.devices(account_id,user_id,name,platform,status,subscription_id)
    values(p_account_id,p_user_id,p_name,'other','ACTIVE',p_subscription_id) returning id into v_device_id;
  insert into public.external_vpn_devices(device_id,account_id,client_type,principal_id,
      subscription_token_hash,desired_route_id)
    values(v_device_id,p_account_id,p_client_type,p_principal_id,p_token_hash,p_route_id);
  insert into public.compatibility_credentials(device_id,credential_id,credential_ciphertext,
      credential_nonce,valid_from,valid_until,publish_from)
    values(v_device_id,p_credential_id,p_credential_ciphertext,p_credential_nonce,now(),p_valid_until,now());
  insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,
      logical_route_id,node_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
    select p_principal_id,p_credential_id,'compatibility',p_route_id,t.node_id,now(),p_valid_until,
      false,p_credential_ciphertext,p_credential_nonce
      from public.logical_route_targets t where t.route_id=p_route_id and t.enabled;
  if not found then raise exception 'route_unavailable'; end if;
  return v_device_id;
end $$;

-- Revocation and seat release are atomic in the account plane. The opaque
-- authorization projection remains for the node to observe as revoked.
create or replace function public.revoke_external_vpn_device(p_device_id uuid, p_account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_principal text;
begin
  perform pg_advisory_xact_lock(hashtextextended('external-device:' || p_device_id::text, 0));
  update public.external_vpn_devices set revoked_at=coalesce(revoked_at,now()),
    subscription_token_hash=encode(extensions.gen_random_bytes(32),'hex'), updated_at=now()
    where device_id=p_device_id and account_id=p_account_id and revoked_at is null
    returning principal_id into v_principal;
  if not found then return false; end if;
  update public.compatibility_credentials set revoked_at=coalesce(revoked_at,now()) where device_id=p_device_id;
  update public.compatibility_authorizations set revoked=true, valid_until=least(valid_until,now()), updated_at=now()
    where principal_id=v_principal;
  update public.devices set status='REVOKED', revoked_at=coalesce(revoked_at,now()), subscription_id=null
    where id=p_device_id;
  return true;
end $$;

create or replace function public.rotate_compatibility_credential(
  p_device_id uuid, p_account_id uuid, p_credential_id text,
  p_ciphertext text, p_nonce text, p_valid_until timestamptz,
  p_overlap_seconds integer default 172800
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_device public.external_vpn_devices; v_overlap_until timestamptz;
begin
  if p_overlap_seconds < 3600 or p_overlap_seconds > 259200 then raise exception 'invalid_overlap'; end if;
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || p_device_id::text, 0));
  select * into v_device from public.external_vpn_devices
    where device_id=p_device_id and account_id=p_account_id and revoked_at is null for update;
  if not found then return false; end if;
  v_overlap_until := now() + make_interval(secs => p_overlap_seconds);
  update public.compatibility_credentials set valid_until=least(valid_until,v_overlap_until)
    where device_id=p_device_id and revoked_at is null and valid_until>now();
  update public.compatibility_authorizations set valid_until=least(valid_until,v_overlap_until),updated_at=now()
    where principal_id=v_device.principal_id and revoked=false and valid_until>now();
  delete from public.compatibility_credentials where device_id=p_device_id and valid_until<=now();
  insert into public.compatibility_credentials(device_id,credential_id,credential_ciphertext,
      credential_nonce,valid_from,valid_until,publish_from)
    values(p_device_id,p_credential_id,p_ciphertext,p_nonce,now(),p_valid_until,now());
  insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,
      logical_route_id,node_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
    select v_device.principal_id,p_credential_id,'compatibility',v_device.desired_route_id,t.node_id,
      now(),p_valid_until,false,p_ciphertext,p_nonce from public.logical_route_targets t
      where t.route_id=v_device.desired_route_id and t.enabled;
  if not found then raise exception 'route_unavailable'; end if;
  return true;
end $$;

revoke execute on function public.create_external_vpn_device(uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.revoke_external_vpn_device(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.rotate_compatibility_credential(uuid,uuid,text,text,text,timestamptz,integer)
  from public, anon, authenticated;
