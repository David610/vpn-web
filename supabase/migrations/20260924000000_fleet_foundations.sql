-- Fleet platform Phase 1: domain/schema foundation.
-- See docs/FLEET_PLATFORM_PLAN.md and docs/ADR/0010-fleet-platform-foundations.md
-- (singbox-vpn repo) for the full architecture this implements.
--
-- Purely additive. No existing table is dropped, no column is removed, no
-- credential is rotated. Every new nullable/defaulted column and backfill
-- below preserves "node-1"/existing vpn_accounts rows exactly as they
-- behave today; nothing here changes provisioning_jobs, resolve-node.js's
-- current single-node behavior, or any client-visible API response.

-- ============================================================
-- locations — stable, customer-facing abstraction over disposable nodes
-- (spec §6). A location survives node replacement; nodes reference it.
-- ============================================================
create table public.locations (
  id uuid primary key default extensions.gen_random_uuid(),
  country_code text not null,
  city text,
  display_name text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.locations enable row level security;

-- Enabled locations are safe, non-sensitive product metadata (country/city
-- names) — the future Connections UI (spec §34) needs to list them for any
-- authenticated user, not just account owners.
create policy "locations_select_enabled" on public.locations
  for select
  to authenticated
  using (enabled);

-- A SELECT policy only takes effect once the role already has the
-- underlying SQL privilege — RLS narrows a grant, it cannot substitute for
-- one. Grant select explicitly rather than relying on Supabase's
-- auto_expose_new_tables project default (same reasoning as
-- initial_schema.sql's grant on profiles/subscriptions/vpn_accounts), and
-- revoke every write explicitly: all writes come from service_role.
grant select on public.locations to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.locations
  from anon, authenticated;

-- A placeholder location for the fleet's only node today. Not enabled: it
-- must never appear as a customer-selectable option, since "node-1"'s real
-- region has never been recorded and a wrong guess would misrepresent it.
insert into public.locations (id, country_code, city, display_name, enabled)
values ('00000000-0000-4000-8000-000000000000', 'XX', null, 'Legacy (unassigned)', false);

-- ============================================================
-- nodes — extend the flat registry into a real fleet registry (spec §7).
-- role mirrors singbox-vpn's NodeRole (Exit/Relay) so vpn-web's future
-- scheduler can filter by it without asking the node itself.
-- lifecycle_state and the desired/observed pairs are the reconciliation
-- model from spec §8 — vpn-web is the desired-state source of truth;
-- observed_* is only ever written by the node's own heartbeat.
-- ============================================================
alter table public.nodes
  add column location_id uuid references public.locations (id),
  add column role text not null default 'EXIT' check (role in ('EXIT', 'RELAY')),
  add column lifecycle_state text not null default 'READY' check (
    lifecycle_state in (
      'PROVISIONING', 'WARMING_UP', 'READY', 'DEGRADED',
      'DRAINING', 'MAINTENANCE', 'FAILED', 'QUARANTINED', 'RETIRED'
    )
  ),
  add column provider text,
  add column provider_instance_id text,
  add column asn integer,
  add column failure_domain text,
  add column capacity_mbps integer,
  add column max_sessions integer,
  add column desired_revision bigint not null default 0,
  add column observed_revision bigint not null default 0,
  add column retired_at timestamptz;

-- The single existing node has been serving production traffic since
-- before this migration — READY (the column default already backfilled
-- every existing row) is the honest lifecycle_state for it, not
-- PROVISIONING. location_id has no default because no sensible one exists
-- for a brand-new column; point every pre-existing row at the placeholder
-- location explicitly instead of leaving it null.
update public.nodes set location_id = '00000000-0000-4000-8000-000000000000'
where location_id is null;

create index nodes_location_id_idx on public.nodes (location_id);
create index nodes_lifecycle_state_idx on public.nodes (lifecycle_state);

-- ============================================================
-- devices — first-class, individually-revocable credential owner
-- (spec §4). Every existing vpn_accounts row gets exactly one backfilled
-- "legacy" device below; no VPN credential is touched or rotated.
-- ============================================================
create table public.devices (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  platform text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create index devices_account_id_idx on public.devices (account_id);
create index devices_user_id_idx on public.devices (user_id);

alter table public.devices enable row level security;

create policy "devices_select_own_account" on public.devices
  for select
  to authenticated
  using (
    account_id in (
      select m.account_id from public.account_members m
      where m.user_id = (select auth.uid())
    )
  );

grant select on public.devices to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.devices
  from anon, authenticated;

-- vpn_accounts.device_id — nullable, additive first step of the staged
-- migration in spec §4 ("add nullable device relation -> backfill ->
-- dual-read/dual-write -> validate -> make device ownership canonical").
-- This migration only does step one and the backfill; no application code
-- path is switched to read/write it yet.
alter table public.vpn_accounts
  add column device_id uuid references public.devices (id);

-- Backfill: one legacy device per existing vpn_accounts row, owned by the
-- same account its user_id already belongs to (account_members guarantees
-- exactly one account per user). A vpn_accounts row whose user has since
-- left every account (should not exist under the current one-account-per-
-- user invariant, but the join below simply matches zero rows if it did,
-- rather than raising) is left with a null device_id, unchanged from today.
--
-- vpn_accounts is only uniquely keyed on (user_id, node_id), not user_id
-- alone, so a user with more than one vpn_accounts row is not something a
-- constraint rules out even though no code path creates one today. Pairing
-- purely on user_id would let such a user's rows cross-match each other's
-- backfilled device nondeterministically. row_number() pairs each
-- vpn_accounts row with its own distinct backfilled device instead, so the
-- result is correct regardless of how many rows a user has.
with legacy_devices as (
  insert into public.devices (account_id, user_id, name, status, created_at)
  select m.account_id, va.user_id, 'Legacy device', 'ACTIVE', va.created_at
  from public.vpn_accounts va
  join public.account_members m on m.user_id = va.user_id
  returning id as device_id, user_id
),
numbered_devices as (
  select device_id, user_id,
    row_number() over (partition by user_id order by device_id) as rn
  from legacy_devices
),
numbered_accounts as (
  select id as vpn_account_id, user_id,
    row_number() over (partition by user_id order by id) as rn
  from public.vpn_accounts
)
update public.vpn_accounts va
set device_id = nd.device_id
from numbered_accounts na
join numbered_devices nd on nd.user_id = na.user_id and nd.rn = na.rn
where va.id = na.vpn_account_id;

create index vpn_accounts_device_id_idx on public.vpn_accounts (device_id);

-- ============================================================
-- connection_profiles — policy, not billing/credential/infrastructure
-- (spec §10). One active profile per device (device_profile_assignments
-- below), never touching Stripe on reassignment.
-- ============================================================
create table public.connection_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  routing_mode text not null check (routing_mode in ('AUTO', 'DIRECT', 'DOUBLE_HOP')),
  preferred_entry_location_id uuid references public.locations (id),
  preferred_exit_location_id uuid references public.locations (id),
  auto_failover boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- DIRECT/AUTO name an exit only; DOUBLE_HOP names both hops. Enforced
  -- here rather than only in application code, since this is a data
  -- integrity rule, not a UX rule.
  constraint connection_profiles_entry_requires_double_hop check (
    (routing_mode = 'DOUBLE_HOP' and preferred_entry_location_id is not null)
    or (routing_mode <> 'DOUBLE_HOP' and preferred_entry_location_id is null)
  )
);

create index connection_profiles_account_id_idx on public.connection_profiles (account_id);

create trigger connection_profiles_set_updated_at
  before update on public.connection_profiles
  for each row execute function public.set_updated_at();

alter table public.connection_profiles enable row level security;

create policy "connection_profiles_select_own_account" on public.connection_profiles
  for select
  to authenticated
  using (
    account_id in (
      select m.account_id from public.account_members m
      where m.user_id = (select auth.uid())
    )
  );

grant select on public.connection_profiles to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.connection_profiles
  from anon, authenticated;

-- device_profile_assignments — one active profile per device is the
-- simplest initial rule (spec §10); the primary key on device_id enforces
-- it structurally rather than by convention.
create table public.device_profile_assignments (
  device_id uuid primary key references public.devices (id) on delete cascade,
  profile_id uuid not null references public.connection_profiles (id) on delete cascade,
  assigned_at timestamptz not null default now()
);

create index device_profile_assignments_profile_id_idx
  on public.device_profile_assignments (profile_id);

alter table public.device_profile_assignments enable row level security;

create policy "device_profile_assignments_select_own_account" on public.device_profile_assignments
  for select
  to authenticated
  using (
    device_id in (
      select d.id from public.devices d
      join public.account_members m on m.account_id = d.account_id
      where m.user_id = (select auth.uid())
    )
  );

grant select on public.device_profile_assignments to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.device_profile_assignments
  from anon, authenticated;

-- ============================================================
-- allowed_paths — central allowlist of which entry x exit location pairs
-- may exist (spec §12, §17). Empty until routes are explicitly approved;
-- the scheduler (a later phase) must treat "no matching row" as "not
-- permitted", never fall back to allowing an unlisted pair.
-- ============================================================
create table public.allowed_paths (
  id uuid primary key default extensions.gen_random_uuid(),
  entry_location_id uuid references public.locations (id),
  exit_location_id uuid not null references public.locations (id),
  enabled boolean not null default false,
  required_entitlement text,
  created_at timestamptz not null default now(),
  constraint allowed_paths_distinct_hops check (
    entry_location_id is null or entry_location_id <> exit_location_id
  )
);

-- At most one direct (entry-less) path per exit, and at most one
-- double-hop path per (entry, exit) pair — two separate partial indexes
-- rather than one coalesce(...) expression, so the uniqueness rule for
-- each routing shape stays readable on its own.
create unique index allowed_paths_direct_route_uniq
  on public.allowed_paths (exit_location_id) where entry_location_id is null;
create unique index allowed_paths_double_hop_route_uniq
  on public.allowed_paths (entry_location_id, exit_location_id) where entry_location_id is not null;

alter table public.allowed_paths enable row level security;
revoke all on public.allowed_paths from anon, authenticated;

-- ============================================================
-- fleet_operations / operation_steps — multi-node sagas (spec §24).
-- Distributed multi-node changes are not one atomic DB transaction; this
-- is the explicit compensation/reconciliation record for them instead.
-- ============================================================
create table public.fleet_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  type text not null,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL_FAILURE', 'ROLLING_BACK', 'FAILED')
  ),
  account_id uuid references public.customer_accounts (id) on delete set null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fleet_operations_account_id_idx on public.fleet_operations (account_id);
create index fleet_operations_status_idx on public.fleet_operations (status);

create trigger fleet_operations_set_updated_at
  before update on public.fleet_operations
  for each row execute function public.set_updated_at();

alter table public.fleet_operations enable row level security;
revoke all on public.fleet_operations from anon, authenticated;

create table public.operation_steps (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.fleet_operations (id) on delete cascade,
  step_index integer not null,
  node_id text references public.nodes (node_id),
  status text not null default 'PENDING' check (
    status in ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')
  ),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index operation_steps_operation_step_uniq
  on public.operation_steps (operation_id, step_index);
create index operation_steps_node_id_idx on public.operation_steps (node_id);

alter table public.operation_steps enable row level security;
revoke all on public.operation_steps from anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;
