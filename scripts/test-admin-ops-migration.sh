#!/usr/bin/env bash
set -euo pipefail

# Targeted fallback for the newest admin-ops migration when Supabase's
# container registry is unavailable. The complete migration chain already
# passed in CI through 20260923170000; this validates 190000's SQL and the
# snapshot semantics without Docker.

DB="arcana_admin_ops_migration_$RANDOM-$RANDOM"
cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo systemctl start postgresql
sudo -u postgres createdb "$DB"

psql_db() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" "$@"
}

psql_db <<'SQL'
create schema if not exists public;

create table public.customer_accounts (
  id uuid primary key
);

create table public.subscriptions (
  id bigint generated always as identity primary key,
  account_id uuid references public.customer_accounts(id),
  status text not null,
  extra_seats integer not null default 0
);

create table public.account_members (
  id bigint generated always as identity primary key,
  account_id uuid references public.customer_accounts(id)
);

create table public.member_invites (
  id bigint generated always as identity primary key,
  account_id uuid references public.customer_accounts(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null
);

create table public.admin_entitlements (
  id uuid primary key,
  account_id uuid references public.customer_accounts(id),
  status text not null,
  starts_at timestamptz not null,
  expires_at timestamptz
);

create table public.vpn_accounts (
  id bigint generated always as identity primary key,
  enabled boolean not null
);

create table public.provisioning_jobs (
  id bigint generated always as identity primary key,
  status text not null,
  created_at timestamptz not null default now()
);

create table public.nodes (
  node_id text primary key,
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table public.node_traffic_samples (
  id bigint generated always as identity primary key,
  node_id text not null,
  delta_up bigint,
  delta_down bigint,
  interval_seconds integer,
  sampled_at timestamptz not null
);

create table public.node_traffic_daily (
  node_id text not null,
  day date not null,
  bytes_up bigint not null default 0,
  bytes_down bigint not null default 0
);

create table public.operational_alerts (
  id bigint generated always as identity primary key,
  status text not null
);

create table public.abuse_signals (
  id bigint generated always as identity primary key,
  review_status text not null,
  flagged boolean not null
);

create role anon;
create role authenticated;
create role service_role;
SQL

psql_db -f supabase/migrations/20260923190000_admin_ops_scaling.sql

psql_db <<'SQL'
insert into public.customer_accounts(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.subscriptions(account_id,status,extra_seats) values
  ('00000000-0000-4000-8000-000000000001','active',2),
  ('00000000-0000-4000-8000-000000000002','trialing',1),
  ('00000000-0000-4000-8000-000000000002','canceled',9);

insert into public.account_members(account_id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.member_invites(account_id,expires_at) values
  ('00000000-0000-4000-8000-000000000001', now() + interval '1 day'),
  ('00000000-0000-4000-8000-000000000001', now() - interval '1 day');

insert into public.admin_entitlements(id,account_id,status,starts_at,expires_at) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','active',now() - interval '1 day',now() + interval '1 day'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','active',now() - interval '2 day',now() - interval '1 day');

insert into public.vpn_accounts(enabled) values (true),(false);
insert into public.provisioning_jobs(status) values ('pending'),('claimed'),('failed');

insert into public.nodes(node_id,last_seen_at) values
  ('node-online', now() - interval '10 seconds'),
  ('node-offline', now() - interval '5 minutes');
insert into public.nodes(node_id,last_seen_at,revoked_at)
  values ('node-revoked', now(), now());

insert into public.node_traffic_samples(node_id,delta_up,delta_down,interval_seconds,sampled_at) values
  ('node-online',100,200,10,now() - interval '30 seconds'),
  ('node-online',300,600,10,now() - interval '5 seconds'),
  ('node-offline',100,200,10,now() - interval '5 minutes');

insert into public.node_traffic_daily(node_id,day,bytes_up,bytes_down) values
  ('node-online',current_date,1000,4000),
  ('node-offline',current_date,500,1500);

insert into public.operational_alerts(status) values ('open'),('resolved');
insert into public.abuse_signals(review_status,flagged) values
  ('open',true),('reviewed',true),('open',false);

do $$
declare
  s jsonb := public.admin_overview_snapshot();
begin
  if (s #>> '{customers,total}')::int <> 2 then raise exception 'bad customer total: %', s; end if;
  if (s #>> '{customers,active}')::int <> 1 then raise exception 'bad active total: %', s; end if;
  if (s #>> '{customers,trialing}')::int <> 1 then raise exception 'bad trial total: %', s; end if;
  if (s #>> '{customers,canceled}')::int <> 1 then raise exception 'bad canceled total: %', s; end if;
  if (s #>> '{members,active}')::int <> 3 then raise exception 'bad member total: %', s; end if;
  if (s #>> '{members,pending_invites}')::int <> 1 then raise exception 'bad invite total: %', s; end if;
  if (s #>> '{members,admin_grants}')::int <> 1 then raise exception 'bad grant total: %', s; end if;
  if (s #>> '{members,paid_extra_seats}')::int <> 3 then raise exception 'bad paid seats: %', s; end if;
  if (s #>> '{vpn,enabled}')::int <> 1 or (s #>> '{vpn,disabled}')::int <> 1 then
    raise exception 'bad vpn totals: %', s;
  end if;
  if (s #>> '{jobs,pending}')::int <> 1
     or (s #>> '{jobs,claimed}')::int <> 1
     or (s #>> '{jobs,failed}')::int <> 1 then
    raise exception 'bad job totals: %', s;
  end if;
  if (s #>> '{nodes,online}')::int <> 1 or (s #>> '{nodes,offline}')::int <> 1 then
    raise exception 'bad node totals: %', s;
  end if;
  if (s #>> '{usage,download_bps}')::int <> 480
     or (s #>> '{usage,upload_bps}')::int <> 240 then
    raise exception 'bad live traffic: %', s;
  end if;
  if (s #>> '{usage,month_total_bytes}')::int <> 7000 then
    raise exception 'bad monthly traffic: %', s;
  end if;
  if (s #>> '{alerts,open}')::int <> 1 or (s #>> '{abuse,open}')::int <> 1 then
    raise exception 'bad ops totals: %', s;
  end if;
end $$;
SQL

echo "admin-ops migration fallback smoke passed"
