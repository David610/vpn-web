-- Arcana customer Links are policy containers around the existing, independently
-- credentialed external_vpn_devices.  The existing device row remains the one
-- canonical capacity unit and compatibility_authorizations remains the only
-- node-facing projection.

create table public.vpn_links (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.customer_accounts(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  configuration_family text not null default 'compatibility'
    check (configuration_family in ('compatibility')),
  desired_route_id text not null references public.logical_routes(id) on delete restrict,
  max_clients integer not null check (max_clients between 1 and 100),
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, account_id),
  check ((status = 'revoked') = (revoked_at is not null))
);

alter table public.external_vpn_devices
  add column link_id uuid,
  add column idempotency_key text,
  add constraint external_vpn_devices_link_account_fk
    foreign key (link_id, account_id) references public.vpn_links(id, account_id) on delete restrict,
  add constraint external_vpn_devices_idempotency_format
    check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  add constraint external_vpn_devices_device_account_unique unique (device_id, account_id),
  add constraint external_vpn_devices_link_identity_unique unique (device_id, link_id, account_id);

create unique index external_vpn_devices_link_idempotency_unique
  on public.external_vpn_devices(link_id, idempotency_key)
  where link_id is not null and idempotency_key is not null;
create index external_vpn_devices_link_idx on public.external_vpn_devices(link_id, created_at);

alter table public.compatibility_credentials
  add column generation integer,
  add column rotated_from uuid references public.compatibility_credentials(id) on delete set null;

with numbered as (
  select id, row_number() over (partition by device_id order by created_at, id)::integer as generation
  from public.compatibility_credentials
)
update public.compatibility_credentials c set generation=n.generation from numbered n where n.id=c.id;
with lineage as (
  select id, lag(id) over (partition by device_id order by generation) as rotated_from
  from public.compatibility_credentials
)
update public.compatibility_credentials c set rotated_from=l.rotated_from
  from lineage l where l.id=c.id;
alter table public.compatibility_credentials alter column generation set not null;
alter table public.compatibility_credentials add constraint compatibility_credentials_generation_positive
  check (generation > 0);
alter table public.compatibility_credentials add constraint compatibility_credentials_device_generation_unique
  unique (device_id, generation);
alter table public.compatibility_credentials add constraint compatibility_credentials_device_id_unique
  unique (device_id, id);
alter table public.compatibility_credentials add constraint compatibility_credentials_same_device_lineage
  foreign key (device_id, rotated_from)
  references public.compatibility_credentials(device_id, id) on delete set null (rotated_from);

-- Daily aggregate counters only. Deliberately no domain, URL, DNS,
-- destination address, packet, or free-form metadata columns exist.
create table public.vpn_link_usage_daily (
  account_id uuid not null references public.customer_accounts(id) on delete cascade,
  link_id uuid not null,
  device_id uuid not null,
  bucket_date date not null,
  rx_bytes bigint not null default 0 check (rx_bytes >= 0),
  tx_bytes bigint not null default 0 check (tx_bytes >= 0),
  connection_count bigint check (connection_count is null or connection_count >= 0),
  last_seen_bucket timestamptz,
  updated_at timestamptz not null default now(),
  primary key (link_id, device_id, bucket_date),
  foreign key (link_id, account_id) references public.vpn_links(id, account_id) on delete cascade,
  foreign key (device_id, link_id, account_id)
    references public.external_vpn_devices(device_id, link_id, account_id) on delete cascade
);

alter table public.vpn_links enable row level security;
alter table public.vpn_link_usage_daily enable row level security;
revoke all on public.vpn_links, public.vpn_link_usage_daily from public, anon, authenticated;
grant all on public.vpn_links, public.vpn_link_usage_daily to service_role;

-- A Link costs no seat. This function only creates the policy container.
create function public.create_vpn_link(
  p_account_id uuid, p_name text, p_route_id text, p_max_clients integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform 1 from public.logical_routes where id=p_route_id and enabled for share;
  if not found then
    raise exception 'route_unavailable';
  end if;
  insert into public.vpn_links(account_id,name,desired_route_id,max_clients)
    values(p_account_id,btrim(p_name),p_route_id,p_max_clients) returning id into v_id;
  return v_id;
end $$;

-- Adds exactly one independently credentialed, seat-bearing client. The Link
-- row lock serializes max_clients enforcement; create_external_vpn_device()
-- retains the subscription lock and canonical existing account capacity rule.
create function public.create_vpn_link_client(
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
    p_token_hash,v_link.desired_route_id,p_credential_id,p_credential_ciphertext,
    p_credential_nonce,p_valid_until);
  update public.external_vpn_devices set link_id=p_link_id,idempotency_key=p_idempotency_key
    where device_id=v_device_id;
  return v_device_id;
end $$;

create function public.revoke_vpn_link(p_link_id uuid, p_account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_device_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('vpn-link:' || p_link_id::text, 0));
  update public.vpn_links set status='revoked',revoked_at=now(),updated_at=now()
    where id=p_link_id and account_id=p_account_id and status='active';
  if not found then return false; end if;
  for v_device_id in select device_id from public.external_vpn_devices
      where link_id=p_link_id and revoked_at is null loop
    perform public.revoke_external_vpn_device(v_device_id,p_account_id);
  end loop;
  return true;
end $$;

create function public.update_vpn_link(
  p_link_id uuid, p_account_id uuid, p_name text, p_max_clients integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_link public.vpn_links;
begin
  select * into v_link from public.vpn_links where id=p_link_id and account_id=p_account_id for update;
  if not found or v_link.status <> 'active' then return false; end if;
  if (select count(*) from public.external_vpn_devices where link_id=p_link_id and revoked_at is null) > p_max_clients then
    raise exception 'link_capacity_below_active_clients';
  end if;
  update public.vpn_links set name=btrim(p_name),max_clients=p_max_clients,updated_at=now()
    where id=p_link_id;
  return true;
end $$;

-- Set credential generations transactionally without changing the existing
-- make-before-break and node-acknowledgement rotation protocol.
create function public.assign_compatibility_credential_generation()
returns trigger language plpgsql set search_path = '' as $$
declare v_previous public.compatibility_credentials;
begin
  if new.generation is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('compat-credential:' || new.device_id::text, 0));
  select * into v_previous from public.compatibility_credentials
    where device_id=new.device_id order by generation desc limit 1;
  new.generation := coalesce(v_previous.generation,0)+1;
  new.rotated_from := v_previous.id;
  return new;
end $$;
create trigger compatibility_credentials_generation before insert on public.compatibility_credentials
  for each row execute function public.assign_compatibility_credential_generation();

revoke execute on function public.create_vpn_link(uuid,text,text,integer) from public,anon,authenticated;
revoke execute on function public.create_vpn_link_client(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke execute on function public.revoke_vpn_link(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.update_vpn_link(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.create_vpn_link(uuid,text,text,integer) to service_role;
grant execute on function public.create_vpn_link_client(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.revoke_vpn_link(uuid,uuid) to service_role;
grant execute on function public.update_vpn_link(uuid,uuid,text,integer) to service_role;

comment on table public.vpn_links is 'Customer Link policy containers; no credential and no capacity unit.';
comment on table public.vpn_link_usage_daily is 'Privacy-safe per-client daily aggregates; destination telemetry is intentionally absent.';
