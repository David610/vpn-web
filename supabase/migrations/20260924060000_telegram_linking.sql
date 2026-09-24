-- Fleet platform Phase 13: Telegram identity linking + Mini App auth
-- (docs/FLEET_PLATFORM_PLAN.md, phase table).
--
-- Scope: an already-authenticated Arcana account can link a Telegram
-- account to itself. Telegram does NOT become an alternative signup/login
-- path -- linking only. A linked Telegram account then lets a Telegram
-- Mini App resolve to the same internal "authenticated user" via validated
-- `initData` (functions/lib/telegram-init-data.js), reusing existing
-- account/devices/seats endpoints rather than duplicating them.
--
-- Purely additive. No existing table/column touched.

-- ============================================================
-- telegram_links -- one row per linked Telegram account. Customer-visible
-- (a user should be able to see/confirm their own link), so it follows the
-- customer-visible RLS house style: RLS enabled, all writes revoked from
-- anon/authenticated, explicit grant select, SELECT policy scoped to the
-- requesting user's own row. Mutations (link/unlink) only ever happen via
-- a Cloudflare Function using the service-role key, exactly like
-- member_invites/devices.
-- ============================================================
create table public.telegram_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  telegram_user_id bigint not null,
  telegram_username text,
  linked_at timestamptz not null default now()
);

-- One Telegram account can link to at most one Arcana account (prevents a
-- single Telegram identity silently hijacking multiple accounts' Mini App
-- sessions).
create unique index telegram_links_telegram_user_id_uniq
  on public.telegram_links (telegram_user_id);

alter table public.telegram_links enable row level security;

create policy "telegram_links_select_own" on public.telegram_links
  for select
  to authenticated
  using (auth.uid() = user_id);

grant select on public.telegram_links to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.telegram_links
  from anon, authenticated;

-- ============================================================
-- telegram_link_codes -- short-lived, single-use codes an authenticated
-- customer generates on the web dashboard and then supplies to the Mini
-- App (via the Mini App's initData-authenticated request) to prove they
-- are the same person. Internal/service-only table -- never read directly
-- by a customer, so no SELECT policy at all (same pattern as
-- provisioning_jobs / member_invites' raw-token columns).
-- ============================================================
create table public.telegram_link_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index telegram_link_codes_user_id_idx
  on public.telegram_link_codes (user_id);

alter table public.telegram_link_codes enable row level security;
revoke all on public.telegram_link_codes from anon, authenticated;
