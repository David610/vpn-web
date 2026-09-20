-- Arcana initial schema: profiles, billing/VPN provisioning state, and RLS.
-- See docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md §4.

create extension if not exists pgcrypto with schema extensions;

-- ============================================================
-- profiles — one row per Supabase auth user, id mirrors auth.users.id
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- Auto-create a profile row whenever a new auth user is created, so the
-- client never needs (and is never granted) an INSERT policy on this table.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================
-- subscriptions — Stripe subscription state, source of truth is the
-- webhook handler (service_role), never client input.
-- ============================================================
create table public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null check (
    status in ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')
  ),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);
create unique index subscriptions_user_active_uniq
  on public.subscriptions (user_id) where status in ('trialing', 'active', 'past_due');

alter table public.subscriptions enable row level security;

create policy "subscriptions_select_own" on public.subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

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

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ============================================================
-- vpn_accounts — which singbox-vpn user + node a Supabase user maps to.
-- node_id defaults to the single v1 node so a second node later is an
-- additive row change, not a schema migration (spec §4/§9).
-- ============================================================
create table public.vpn_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  vpn_user_id text not null,
  node_id text not null default 'node-1',
  created_at timestamptz not null default now()
);

create index vpn_accounts_user_id_idx on public.vpn_accounts (user_id);
create unique index vpn_accounts_user_node_uniq on public.vpn_accounts (user_id, node_id);

alter table public.vpn_accounts enable row level security;

create policy "vpn_accounts_select_own" on public.vpn_accounts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Explicit, rather than relying on Supabase's auto_expose_new_tables
-- project default — if that default is ever disabled, these three RLS
-- policies must not silently go dead.
grant select on public.profiles, public.subscriptions, public.vpn_accounts to authenticated;

-- RLS does not gate TRUNCATE, and Supabase's auto_expose_new_tables default
-- otherwise grants anon/authenticated full write privileges on new tables —
-- RLS alone is not a write barrier. Revoke explicitly; every write to these
-- three tables comes from server-side service_role code (Stripe webhook,
-- provisioning agent), never from a client.
revoke insert, update, delete, truncate, references, trigger
  on public.profiles, public.subscriptions, public.vpn_accounts
  from anon, authenticated;

-- ============================================================
-- vpn_secrets — AES-GCM-encrypted subscription URL. Never client-readable,
-- by explicit spec requirement, no matter what a future policy author is
-- tempted to add. Encryption key lives outside Postgres entirely (a
-- Cloudflare Worker secret), so this table stores ciphertext only.
-- ciphertext/nonce are raw bytes (bytea). A Cloudflare Worker using Web
-- Crypto's AES-GCM must hex-encode the ArrayBuffer on write and hex-decode
-- on read (PostgREST/psql represent bytea as a "\x"-prefixed hex string,
-- not base64) — see the Stripe-webhook/provisioning-agent plan for the
-- actual conversion code.
-- ============================================================
create table public.vpn_secrets (
  id bigint generated always as identity primary key,
  vpn_account_id bigint not null references public.vpn_accounts (id) on delete cascade,
  ciphertext bytea not null,
  nonce bytea not null check (octet_length(nonce) = 12),
  created_at timestamptz not null default now()
);

create index vpn_secrets_vpn_account_id_idx on public.vpn_secrets (vpn_account_id);

alter table public.vpn_secrets enable row level security;
revoke all on public.vpn_secrets from anon, authenticated;
-- No policies granted to anon/authenticated: RLS is enabled with zero
-- permissive policies for those roles, so every row is denied by default,
-- and the REVOKE above additionally hides the table from the PostgREST/
-- GraphQL schema cache entirely. service_role bypasses RLS as usual.

-- ============================================================
-- provisioning_jobs — idempotency-keyed job queue the VPS provisioning
-- agent polls. Never client-readable or client-writable.
-- ============================================================
create table public.provisioning_jobs (
  id bigint generated always as identity primary key,
  idempotency_key text not null unique,
  vpn_account_id bigint references public.vpn_accounts (id) on delete cascade,
  node_id text not null,
  job_type text not null check (
    job_type in (
      'CREATE_USER',
      'SET_EXPIRY',
      'ENABLE_USER',
      'DISABLE_USER',
      'ROTATE_SUBSCRIPTION_TOKEN'
    )
  ),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'claimed', 'done', 'failed')
  ),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

create index provisioning_jobs_vpn_account_id_idx on public.provisioning_jobs (vpn_account_id);
create index provisioning_jobs_node_status_idx on public.provisioning_jobs (node_id, status);

alter table public.provisioning_jobs enable row level security;
revoke all on public.provisioning_jobs from anon, authenticated;

-- ============================================================
-- stripe_events — raw webhook event log, keyed by Stripe's own event id,
-- for idempotent processing and audit. Never client-readable.
-- ============================================================
create table public.stripe_events (
  id bigint generated always as identity primary key,
  stripe_event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

-- ============================================================
-- abuse_signals — append-only soft-misuse detection log (spec §7),
-- reviewed manually, never auto-enforced, never client-readable.
-- ============================================================
create table public.abuse_signals (
  id bigint generated always as identity primary key,
  vpn_account_id bigint not null references public.vpn_accounts (id) on delete cascade,
  distinct_ip_count integer not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  flagged boolean not null default false,
  created_at timestamptz not null default now()
);

create index abuse_signals_vpn_account_id_idx on public.abuse_signals (vpn_account_id);

alter table public.abuse_signals enable row level security;
revoke all on public.abuse_signals from anon, authenticated;

-- REVOKE ALL on a table does not touch its identity sequence — close that
-- gap for every sequence in the schema in one statement, present and future.
revoke all on all sequences in schema public from anon, authenticated;
