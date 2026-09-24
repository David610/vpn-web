#!/usr/bin/env bash
set -euo pipefail

# Targeted fallback for the fleet-foundations migration when Supabase's
# container registry is unavailable. Rebuilds just the upstream tables this
# migration depends on (auth.users, customer_accounts, account_members,
# vpn_accounts, nodes, set_updated_at), inserts data that PRE-DATES the
# migration (so its own backfill statements, not this test, populate the
# new columns), then applies 20260924000000_fleet_foundations.sql and
# asserts:
#   - the legacy location + pre-existing node backfill lands correctly
#   - the legacy-device backfill produces exactly one device for the
#     pre-existing vpn_accounts row, owned by the right account
#   - the DOUBLE_HOP entry-location check constraint is enforced
#   - the allowed_paths distinct-hops check constraint is enforced
#   - one-active-profile-per-device is enforced structurally

DB="arcana_fleet_foundations_$RANDOM-$RANDOM"
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
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema auth;
create table auth.users (
  id uuid primary key
);

-- Supabase's real Postgres provides auth.uid() (reads the request JWT);
-- this fallback schema doesn't run under PostgREST, but the migration's
-- RLS policies reference it in their USING clause, and CREATE POLICY
-- resolves that function signature at creation time even though it's only
-- evaluated per-query. This test runs entirely as the postgres superuser
-- (RLS is bypassed for superusers), so the stub's return value is never
-- actually exercised — it only needs to exist for the migration to apply.
create function auth.uid()
returns uuid
language sql stable
as $$ select null::uuid; $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.customer_accounts (
  id uuid primary key default extensions.gen_random_uuid()
);

create table public.account_members (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.customer_accounts (id),
  user_id uuid not null references auth.users (id),
  role text not null
);
create unique index account_members_user_uniq on public.account_members (user_id);

create table public.vpn_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  vpn_user_id text not null,
  node_id text not null default 'node-1',
  created_at timestamptz not null default now()
);

create table public.nodes (
  node_id text primary key,
  api_key_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Everything below pre-dates the migration, so the migration's own
-- backfill statements (not this test's setup) are what populate
-- lifecycle_state/location_id/device_id, asserted after it runs.
insert into public.nodes (node_id, api_key_hash) values ('node-1', 'x');

insert into auth.users (id) values ('10000000-0000-4000-8000-000000000001');
insert into public.customer_accounts (id)
  values ('20000000-0000-4000-8000-000000000001');
insert into public.account_members (account_id, user_id, role) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner');
insert into public.vpn_accounts (user_id, vpn_user_id) values
  ('10000000-0000-4000-8000-000000000001', 'vpnuser1');
SQL

psql_db -f supabase/migrations/20260924000000_fleet_foundations.sql

psql_db <<'SQL'
do $$
declare
  v_account_id uuid := '20000000-0000-4000-8000-000000000001';
  v_device_id uuid;
  v_profile_id uuid;
  v_legacy_location uuid := '00000000-0000-4000-8000-000000000000';
  v_de_location uuid := extensions.gen_random_uuid();
  v_nl_location uuid := extensions.gen_random_uuid();
begin
  -- ---- node backfill ----------------------------------------------------
  if (select lifecycle_state from public.nodes where node_id = 'node-1') <> 'READY' then
    raise exception 'the pre-existing node was not backfilled to READY lifecycle_state';
  end if;

  if (select location_id from public.nodes where node_id = 'node-1') <> v_legacy_location then
    raise exception 'the pre-existing node was not backfilled to the legacy placeholder location';
  end if;

  -- ---- device backfill ---------------------------------------------------
  select device_id into v_device_id from public.vpn_accounts where vpn_user_id = 'vpnuser1';

  if v_device_id is null then
    raise exception 'the pre-existing vpn_accounts row was not backfilled with a device';
  end if;

  if (select account_id from public.devices where id = v_device_id) <> v_account_id then
    raise exception 'the backfilled device was attributed to the wrong account';
  end if;

  if (select count(*) from public.devices where user_id = '10000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'the backfill produced more than one device for a single pre-existing vpn_accounts row';
  end if;

  -- ---- connection_profiles check constraint -------------------------------
  insert into public.locations (id, country_code, display_name, enabled)
  values (v_de_location, 'DE', 'Germany', true), (v_nl_location, 'NL', 'Netherlands', true);

  begin
    insert into public.connection_profiles (account_id, name, routing_mode, preferred_entry_location_id)
    values (v_account_id, 'bad-direct-with-entry', 'DIRECT', v_nl_location);
    raise exception 'DIRECT profile with an entry location was incorrectly allowed';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.connection_profiles (account_id, name, routing_mode, preferred_exit_location_id)
    values (v_account_id, 'bad-double-hop-no-entry', 'DOUBLE_HOP', v_de_location);
    raise exception 'DOUBLE_HOP profile with no entry location was incorrectly allowed';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.connection_profiles (account_id, name, routing_mode)
    values (v_account_id, 'bad-direct-no-exit', 'DIRECT');
    raise exception 'DIRECT profile with no exit location was incorrectly allowed';
  exception
    when check_violation then null;
  end;

  -- AUTO is the one routing mode allowed to leave both locations unset
  -- (a broad regional preference, not one specific location).
  insert into public.connection_profiles (account_id, name, routing_mode)
  values (v_account_id, 'Automatic', 'AUTO');

  insert into public.connection_profiles (account_id, name, routing_mode, preferred_exit_location_id)
  values (v_account_id, 'Germany Direct', 'DIRECT', v_de_location)
  returning id into v_profile_id;

  -- ---- one active profile per device ---------------------------------------
  insert into public.device_profile_assignments (device_id, profile_id) values (v_device_id, v_profile_id);

  begin
    insert into public.device_profile_assignments (device_id, profile_id) values (v_device_id, v_profile_id);
    raise exception 'a second profile assignment for the same device was incorrectly allowed';
  exception
    when unique_violation then null;
  end;

  -- ---- allowed_paths distinct-hops check constraint -------------------------
  begin
    insert into public.allowed_paths (entry_location_id, exit_location_id)
    values (v_de_location, v_de_location);
    raise exception 'an allowed_paths row with identical entry and exit was incorrectly allowed';
  exception
    when check_violation then null;
  end;

  insert into public.allowed_paths (entry_location_id, exit_location_id) values (v_nl_location, v_de_location);

  -- ---- placeholder location is present and disabled --------------------------
  if (select enabled from public.locations where id = v_legacy_location) then
    raise exception 'the legacy placeholder location must not be customer-selectable';
  end if;
end $$;
SQL

echo "fleet foundations migration test passed"
