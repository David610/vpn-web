-- admin_users — allow-list of Supabase auth users who may call
-- /api/admin/*. service_role only, same revoke-by-default pattern as
-- nodes/vpn_secrets/stripe_events (supabase/migrations/20260921000000_initial_schema.sql).
-- There is no signup path for this table on purpose: the first "owner"
-- row is inserted once via scripts/grant-admin.mjs, run manually with
-- the service-role key, never through a client-facing endpoint.
create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'operator', 'readonly')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- admin_audit_log — append-only record of every admin mutation. Never
-- put secrets (subscription URLs, node API keys, private keys) into
-- metadata — see functions/lib/admin-audit.js's doc comment.
create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users (id),
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_created_at_idx on public.admin_audit_log (created_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;

-- nodes.last_seen_at — updated by functions/api/agent/claim.js on every
-- successful node authentication (Task 5). No separate heartbeat
-- endpoint yet: the agent already calls /api/agent/claim roughly every
-- 15s, so this piggybacks on an existing call instead of adding one.
alter table public.nodes add column last_seen_at timestamptz;

-- vpn_accounts.enabled — today's completion handler
-- (functions/api/agent/jobs/[id]/complete.js) does not persist
-- ENABLE_USER/DISABLE_USER outcomes anywhere; the admin dashboard's
-- customer view needs a real answer to "is this account currently
-- enabled", so Task 5 adds that write. Defaults true because every
-- vpn_accounts row is created by a successful CREATE_USER completion,
-- which leaves the account enabled.
alter table public.vpn_accounts add column enabled boolean not null default true;

revoke all on all sequences in schema public from anon, authenticated;
