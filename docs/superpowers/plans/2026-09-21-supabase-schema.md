# Arcana Supabase schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Supabase database schema this product's billing/VPN-provisioning lifecycle depends on — `profiles`, `subscriptions`, `vpn_accounts`, `vpn_secrets`, `provisioning_jobs`, `stripe_events`, `abuse_signals` — with Row Level Security locked down table-by-table, and prove the RLS actually enforces the intended boundaries with real queries against a real local Postgres instance (not asserted from reading the policy text).

**Architecture:** Standard Supabase CLI project layout (`supabase/migrations/*.sql`) tested against the Supabase CLI's local dev stack (`supabase start`, which runs real Postgres + GoTrue + PostgREST in Docker — this is genuine RLS enforcement, not a mock). One initial migration creates every table, its RLS policies, and its indexes. A seed script inserts two fake users with one row in every table each, so the RLS test script that follows can prove things like "user A cannot see user B's `subscriptions` row" and "the anon role cannot read `vpn_secrets` at all" against real data, not empty tables. No application code (Next.js, Cloudflare Functions) touches this schema yet — that's later plans (auth, Stripe webhook, provisioning agent, dashboard).

**Tech Stack:** PostgreSQL (via Supabase CLI's local Docker stack), plain SQL migrations, a `psql`-driven RLS test script (no pgTAP — kept dependency-free, using `DO $$ ... RAISE EXCEPTION ... END $$` blocks that make `psql -v ON_ERROR_STOP=1` fail loudly and precisely on any policy violation).

**Spec:** `docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md` in the sibling repo `singbox-vpn` (absolute path on this machine: `D:\ISDA\singbox-vpn\docs\superpowers\specs\2026-09-20-vpn-website-mvp-design.md`) — §4 (data model), §9 item 3 (Supabase RLS review requirement).

## Global Constraints

- Every table that stores data belonging to an individual customer (`profiles`, `subscriptions`, `vpn_accounts`) gets RLS enabled and a `SELECT`-only policy scoped to `(select auth.uid()) = user_id` (or `id` for `profiles`) for the `authenticated` role. No `INSERT`/`UPDATE`/`DELETE` policy is granted to `authenticated` on any table in this plan — every write in this product comes from server-side code using the Supabase `service_role` key (the Stripe webhook handler, the provisioning agent), which bypasses RLS entirely; granting client-side write policies here would be scope creep this plan doesn't need.
- `vpn_secrets`, `provisioning_jobs`, `stripe_events`, and `abuse_signals` are **never** readable by `anon` or `authenticated` — `REVOKE ALL ... FROM anon, authenticated` on each, no policies granting anything back. This matches the spec's explicit requirement ("`vpn_secrets` must not have client-readable RLS policies at all") and is applied uniformly to every table server-side automation alone should touch.
- Every RLS policy that checks `auth.uid()` wraps it as `(select auth.uid())`, never a bare `auth.uid()` — this is a real Postgres performance requirement (the bare form re-evaluates the function per row instead of once), not a style preference.
- Every foreign-key column gets an explicit index — Postgres does not create one automatically, and both the RLS policy checks and `ON DELETE CASCADE` need it.
- Primary keys: `profiles.id` is the one exception and equals `auth.users.id` (a UUID, by Supabase convention — every other Supabase project does this, and diverging from it breaks the standard `auth.uid() = profiles.id` pattern). Every other table uses `bigint generated always as identity` — avoids the UUIDv4 index-fragmentation problem on tables that will actually grow (`provisioning_jobs`, `stripe_events`, `abuse_signals`).
- `job_type` in `provisioning_jobs` is restricted by a `CHECK` constraint to exactly the five values the spec's provisioning-agent contract names: `CREATE_USER`, `SET_EXPIRY`, `ENABLE_USER`, `DISABLE_USER`, `ROTATE_SUBSCRIPTION_TOKEN`. No other value is a schema change waiting to happen, not a typo waiting to happen.
- No secrets, API keys, or real customer data anywhere in this plan's seed/test data — synthetic UUIDs and fake Stripe-shaped IDs only.

---

## Task 1: Initial schema migration, RLS policies, seed data, and RLS verification tests

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/migrations/20260921000000_initial_schema.sql`
- Create: `supabase/seed.sql`
- Create: `supabase/tests/rls_test.sql`
- Create: `.gitignore` update (append Supabase-local entries — the existing `.gitignore` from the scaffold plan already has the tooling entries; this adds `supabase/.branches`, `supabase/.temp`)

**Interfaces:**
- Consumes: nothing from prior plans (first database work in this repo).
- Produces: the 7 tables and their columns below — this is the vocabulary every later plan (auth, Stripe webhook, provisioning agent, dashboard) reads and writes against. Exact column names/types are load-bearing for those plans, so they're specified in full here rather than left to be inferred:
  - `public.profiles(id uuid pk = auth.users.id, created_at)`
  - `public.subscriptions(id bigint pk, user_id uuid, stripe_customer_id text, stripe_subscription_id text unique, status text, current_period_end timestamptz, created_at, updated_at)`
  - `public.vpn_accounts(id bigint pk, user_id uuid, vpn_user_id text, node_id text default 'node-1', created_at)`
  - `public.vpn_secrets(id bigint pk, vpn_account_id bigint fk, ciphertext bytea, nonce bytea, created_at)`
  - `public.provisioning_jobs(id bigint pk, idempotency_key text unique, vpn_account_id bigint fk nullable, node_id text, job_type text, payload jsonb, status text default 'pending', claimed_at, completed_at, result jsonb, created_at)`
  - `public.stripe_events(id bigint pk, stripe_event_id text unique, event_type text, payload jsonb, processed_at, created_at)`
  - `public.abuse_signals(id bigint pk, vpn_account_id bigint fk, distinct_ip_count integer, window_start timestamptz, window_end timestamptz, flagged boolean default false, created_at)`

- [ ] **Step 1: Verify the Supabase CLI and Docker are available**

Run: `npx --yes supabase --version` (expect a version string, e.g. `2.x.x`) and `docker ps` (expect a container list or an empty table header, not a connection error — if Docker Desktop isn't running, start it and wait for `docker ps` to succeed before continuing; this step cannot proceed without it).

- [ ] **Step 2: Initialize the Supabase project**

Run: `npx supabase init` from the repo root (`D:\ISDA\vpn-web`). Answer prompts with defaults (no VS Code settings needed — decline if asked). This creates `supabase/config.toml` and a `supabase/` directory structure.

Expected: `supabase/config.toml` exists, `supabase/migrations/` directory exists (empty).

- [ ] **Step 3: Write the initial migration**

Create `supabase/migrations/20260921000000_initial_schema.sql`:

```sql
-- Arcana initial schema: profiles, billing/VPN provisioning state, and RLS.
-- See docs/superpowers/specs/2026-09-20-vpn-website-mvp-design.md §4.

create extension if not exists pgcrypto;

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

alter table public.subscriptions enable row level security;

create policy "subscriptions_select_own" on public.subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

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

alter table public.vpn_accounts enable row level security;

create policy "vpn_accounts_select_own" on public.vpn_accounts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- vpn_secrets — AES-GCM-encrypted subscription URL. Never client-readable,
-- by explicit spec requirement, no matter what a future policy author is
-- tempted to add. Encryption key lives outside Postgres entirely (a
-- Cloudflare Worker secret), so this table stores ciphertext only.
-- ============================================================
create table public.vpn_secrets (
  id bigint generated always as identity primary key,
  vpn_account_id bigint not null references public.vpn_accounts (id) on delete cascade,
  ciphertext bytea not null,
  nonce bytea not null,
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
```

- [ ] **Step 4: Write the seed script**

Create `supabase/seed.sql`:

```sql
-- Two synthetic users with one row in every table, so the RLS test script
-- has real cross-user data to prove isolation against (not empty tables).
-- No real credentials, no real Stripe/VPN identifiers anywhere here.

insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'user-a@example.test', crypt('test-password-a', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@example.test', crypt('test-password-b', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated');
-- public.profiles rows for both are created automatically by the
-- on_auth_user_created trigger from the migration.

insert into public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
values
  ('11111111-1111-1111-1111-111111111111', 'cus_test_a', 'sub_test_a', 'active', now() + interval '30 days'),
  ('22222222-2222-2222-2222-222222222222', 'cus_test_b', 'sub_test_b', 'active', now() + interval '30 days');

insert into public.vpn_accounts (id, user_id, vpn_user_id, node_id)
values
  (1, '11111111-1111-1111-1111-111111111111', 'vpn_user_test_a', 'node-1'),
  (2, '22222222-2222-2222-2222-222222222222', 'vpn_user_test_b', 'node-1');

insert into public.vpn_secrets (vpn_account_id, ciphertext, nonce)
values
  (1, '\xdeadbeef', '\x000000000000000000000001'),
  (2, '\xfeedface', '\x000000000000000000000002');

insert into public.provisioning_jobs (idempotency_key, vpn_account_id, node_id, job_type, status)
values
  ('idem-test-a-create', 1, 'node-1', 'CREATE_USER', 'done'),
  ('idem-test-b-create', 2, 'node-1', 'CREATE_USER', 'done');

insert into public.stripe_events (stripe_event_id, event_type, payload)
values
  ('evt_test_a', 'invoice.paid', '{"test": true, "user": "a"}'::jsonb),
  ('evt_test_b', 'invoice.paid', '{"test": true, "user": "b"}'::jsonb);

insert into public.abuse_signals (vpn_account_id, distinct_ip_count, window_start, window_end, flagged)
values
  (1, 2, now() - interval '1 day', now(), false),
  (2, 9, now() - interval '1 day', now(), true);
```

- [ ] **Step 5: Write the RLS verification test script**

Create `supabase/tests/rls_test.sql`:

```sql
-- Real-Postgres RLS verification. Run with:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
-- Every assertion RAISEs on failure, which makes psql exit non-zero — a
-- failing assertion fails the whole script, not just prints a warning.
-- This proves RLS is actually enforced by a real Postgres instance, not
-- just present in the policy text.

\set user_a '11111111-1111-1111-1111-111111111111'
\set user_b '22222222-2222-2222-2222-222222222222'

-- ── profiles: a user sees only their own row ──────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  visible_count int;
begin
  select count(*) into visible_count from public.profiles;
  if visible_count <> 1 then
    raise exception 'profiles RLS FAILED: user A should see exactly 1 profile row, saw %', visible_count;
  end if;
  if not exists (select 1 from public.profiles where id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'profiles RLS FAILED: user A cannot see their own profile row';
  end if;
end $$;
rollback;

-- ── subscriptions: user A cannot see user B's row ─────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  own_count int;
  other_count int;
begin
  select count(*) into own_count from public.subscriptions where user_id = '11111111-1111-1111-1111-111111111111';
  select count(*) into other_count from public.subscriptions where user_id = '22222222-2222-2222-2222-222222222222';
  if own_count <> 1 then
    raise exception 'subscriptions RLS FAILED: user A should see their own 1 row, saw %', own_count;
  end if;
  if other_count <> 0 then
    raise exception 'subscriptions RLS FAILED: user A should see 0 of user B''s rows, saw %', other_count;
  end if;
end $$;
rollback;

-- ── vpn_accounts: same cross-user isolation check ─────────────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_accounts;
  if total <> 1 then
    raise exception 'vpn_accounts RLS FAILED: user A should see exactly 1 row, saw %', total;
  end if;
  if exists (select 1 from public.vpn_accounts where vpn_user_id = 'vpn_user_test_b') then
    raise exception 'vpn_accounts RLS FAILED: user A can see user B''s account';
  end if;
end $$;
rollback;

-- ── vpn_secrets: authenticated role gets ZERO rows, not even their own ─
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_secrets;
  if total <> 0 then
    raise exception 'vpn_secrets RLS FAILED: authenticated role should see 0 rows (no policy grants access), saw %', total;
  end if;
end $$;
rollback;

-- ── vpn_secrets: anon role also gets nothing ───────────────────────────
begin;
set local role anon;
do $$
declare
  total int;
begin
  select count(*) into total from public.vpn_secrets;
  if total <> 0 then
    raise exception 'vpn_secrets RLS FAILED: anon role should see 0 rows, saw %', total;
  end if;
end $$;
exception when insufficient_privilege then
  -- REVOKE ALL means anon may not even have SELECT privilege to attempt
  -- the query at all, which is an equally valid (in fact stronger) way
  -- for this assertion to be satisfied.
  raise notice 'vpn_secrets: anon role correctly has no privilege to query the table at all';
end $$;
rollback;

-- ── provisioning_jobs / stripe_events / abuse_signals: same "zero rows
--    for authenticated, zero for anon" shape as vpn_secrets ─────────────
begin;
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
do $$
declare
  jobs_count int;
  events_count int;
  abuse_count int;
begin
  select count(*) into jobs_count from public.provisioning_jobs;
  select count(*) into events_count from public.stripe_events;
  select count(*) into abuse_count from public.abuse_signals;
  if jobs_count <> 0 then
    raise exception 'provisioning_jobs RLS FAILED: authenticated should see 0 rows, saw %', jobs_count;
  end if;
  if events_count <> 0 then
    raise exception 'stripe_events RLS FAILED: authenticated should see 0 rows, saw %', events_count;
  end if;
  if abuse_count <> 0 then
    raise exception 'abuse_signals RLS FAILED: authenticated should see 0 rows, saw %', abuse_count;
  end if;
end $$;
rollback;

-- ── service_role bypasses RLS entirely on every table (sanity check that
--    the schema doesn't accidentally block the server-side path too) ────
begin;
set local role service_role;
do $$
declare
  secrets_count int;
  jobs_count int;
begin
  select count(*) into secrets_count from public.vpn_secrets;
  select count(*) into jobs_count from public.provisioning_jobs;
  if secrets_count <> 2 then
    raise exception 'service_role FAILED: should see all 2 vpn_secrets rows, saw %', secrets_count;
  end if;
  if jobs_count <> 2 then
    raise exception 'service_role FAILED: should see all 2 provisioning_jobs rows, saw %', jobs_count;
  end if;
end $$;
rollback;

\echo 'All RLS assertions passed.'
```

Note on the `vpn_secrets`/anon block: depending on exactly how `REVOKE ALL` interacts with `SET ROLE anon` inside a `DO` block in the local Supabase Postgres image, the failure mode may be an `insufficient_privilege` error (caught) rather than a 0-row result — the script handles both as a pass. If Step 8's run shows this block errors in an *uncaught* way, that's a real finding to report, not something to silently work around.

- [ ] **Step 6: Update `.gitignore`**

Append to the existing `.gitignore` (created by the scaffold plan):

```
# Supabase CLI local state
/supabase/.branches
/supabase/.temp
```

- [ ] **Step 7: Start the local Supabase stack and apply the migration**

Run: `npx supabase start` (first run pulls Docker images, can take several minutes; subsequent runs are fast). Note the printed `DB URL` (typically `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) — later steps need it.

Run: `npx supabase db reset` — this applies every migration in `supabase/migrations/` to a fresh database AND runs `supabase/seed.sql` automatically (Supabase CLI convention: `db reset` always re-seeds).

Expected: both commands succeed with no errors. `db reset` output should show the migration applying and ending with the seed script's inserts running without constraint violations.

- [ ] **Step 8: Run the RLS test script and verify it passes**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql`

(If `psql` isn't on PATH, it ships inside the Supabase CLI's Docker containers — as a fallback, run it via `docker exec -i supabase_db_vpn-web psql -U postgres -v ON_ERROR_STOP=1 -f -` piping the file in, or `npx supabase db psql` if that subcommand allows piping a file with `-v ON_ERROR_STOP=1` — try direct `psql` first since it's the cleanest, only fall back if genuinely unavailable, and note in your report which path was used.)

Expected: exits 0, final output line is `All RLS assertions passed.`, no `ERROR:` or `RLS FAILED` lines anywhere in the output.

- [ ] **Step 9: Deliberately break one policy and confirm the test catches it**

This is the negative-control check that proves the test script actually tests something, rather than passing vacuously. Temporarily comment out the `using ((select auth.uid()) = user_id)` clause in `subscriptions_select_own` in the migration file (or more simply, run this ad hoc against the running instance without editing the migration file: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "alter policy subscriptions_select_own on public.subscriptions using (true);"` — this makes the policy permit every row, simulating the bug the test should catch), then re-run Step 8's command.

Expected: FAILS with `subscriptions RLS FAILED: user A should see 0 of user B's rows, saw 1`. This confirms the test is a real check, not a tautology.

Then undo the deliberate break: `npx supabase db reset` (re-applies the real migration from the file, discarding the ad hoc `alter policy`).

- [ ] **Step 10: Re-run the real test one more time to confirm the reset restored the correct policy**

Run Step 8's command again. Expected: passes cleanly again (`All RLS assertions passed.`), confirming `db reset` restored the actual migration file's policy, not the broken ad hoc one.

- [ ] **Step 11: Stop the local stack**

Run: `npx supabase stop` — frees the Docker containers/ports. Not required for the commit itself, but leaves the machine clean.

- [ ] **Step 12: Commit**

```bash
git add supabase/config.toml supabase/migrations/20260921000000_initial_schema.sql supabase/seed.sql supabase/tests/rls_test.sql .gitignore
git commit -m "Add initial Supabase schema with RLS, seed data, and RLS verification tests

profiles/subscriptions/vpn_accounts get authenticated-scoped SELECT
policies; vpn_secrets/provisioning_jobs/stripe_events/abuse_signals
are revoked from anon/authenticated entirely (service_role only).
Verified against a real local Postgres instance via supabase start,
including a negative control (Step 9) proving the RLS test actually
catches a broken policy rather than passing vacuously."
```

---

## Explicitly not in this plan

- Any application code that connects to this schema (Supabase client setup in Next.js, the Stripe webhook handler, the provisioning agent, the dashboard's `/api/vpn/config`) — separate later plans, per the spec's repo layout.
- Actually deploying this schema to a real (non-local) Supabase project — no Supabase account/project has been created yet per the spec's prerequisites (§9 item 3). When one exists, applying this same migration is `npx supabase link` + `npx supabase db push`, not new SQL.
- Custom SMTP, CAPTCHA, and other Supabase-project-level production settings from the spec's prerequisites — those are dashboard/account configuration on a real project, not schema.
- Any `SECURITY DEFINER` helper functions beyond `handle_new_user` — none of the current policies need one (they're all simple `auth.uid() = column` checks); add one only when a later plan's RLS need is actually more complex than that.
