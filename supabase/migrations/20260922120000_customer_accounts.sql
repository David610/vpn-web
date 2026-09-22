-- Customer accounts: move billing from the individual user to an account
-- that can hold several members (3 seats included, more purchasable).
--
-- Before this migration a Supabase user WAS the customer: subscriptions and
-- vpn_accounts both keyed straight off auth.users.id. That cannot express
-- "one subscription, several people, a VPN credential each", so billing moves
-- up one level to customer_accounts and users attach via account_members.
--
-- vpn_accounts deliberately stays keyed on user_id: every member gets their
-- own VLESS UUID / Hysteria2 password, and entitlement is derived by walking
-- user -> account_members -> subscriptions rather than denormalising an
-- account_id onto it that could drift from the membership.
--
-- A user belongs to at most one account (account_members_user_uniq). That is
-- a product decision, not an incidental constraint: it keeps entitlement a
-- single indexed lookup and means no request ever has to ask "which account
-- is this for".

-- ============================================================
-- customer_accounts — the billing entity. The Stripe customer lives here
-- rather than on subscriptions because the billing portal needs a customer
-- id even for an account with no live subscription (lapsed, or never
-- subscribed), which a subscriptions row cannot supply.
-- ============================================================
create table public.customer_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customer_accounts_set_updated_at
  before update on public.customer_accounts
  for each row execute function public.set_updated_at();

alter table public.customer_accounts enable row level security;
revoke all on public.customer_accounts from anon, authenticated;

-- ============================================================
-- account_members — who belongs to which account, and who pays.
-- ============================================================
create table public.account_members (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now()
);

-- One account per user. Accepting an invite therefore means leaving the
-- account you are in, which the invite-acceptance path handles explicitly.
create unique index account_members_user_uniq on public.account_members (user_id);
-- Exactly one owner per account: the party Stripe bills and the only member
-- who can manage seats.
create unique index account_members_owner_uniq
  on public.account_members (account_id) where role = 'owner';
create index account_members_account_idx on public.account_members (account_id);

alter table public.account_members enable row level security;
revoke all on public.account_members from anon, authenticated;

-- ============================================================
-- member_invites — pending seat invitations.
--
-- Only the SHA-256 hash of the invite token is stored, never the token
-- itself, exactly as singbox-vpn treats subscription tokens: a database
-- disclosure must not hand the reader a working invite. The plaintext token
-- exists only in the invite email.
-- ============================================================
create table public.member_invites (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index member_invites_account_idx on public.member_invites (account_id);
create index member_invites_email_idx on public.member_invites (lower(email));

-- At most one live invite per email per account. Expiry is not in the
-- predicate because now() is not immutable and cannot appear in an index;
-- the invite endpoint revokes any existing live invite before issuing a
-- replacement, which keeps this constraint satisfiable.
create unique index member_invites_pending_uniq
  on public.member_invites (account_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table public.member_invites enable row level security;
revoke all on public.member_invites from anon, authenticated;

-- ============================================================
-- subscriptions — repoint from user to account.
-- ============================================================
alter table public.subscriptions
  add column account_id uuid references public.customer_accounts (id) on delete cascade;

-- Seats beyond the 3 included in the base price, mirrored from the quantity
-- of the per-seat Stripe subscription item by the webhook handler.
alter table public.subscriptions
  add column extra_seats integer not null default 0 check (extra_seats >= 0);

-- ---- backfill -------------------------------------------------------
-- Every existing auth user becomes the sole owner of a new account, so the
-- pre-migration world ("a user is a customer") is preserved exactly as the
-- one-member case of the new one. Users with no subscription get an account
-- too: an account is where a trial or checkout will later attach.
-- `pairs` is the user -> new-account mapping, and every branch below must
-- see the same generated ids. AS MATERIALIZED pins that: it forces a single
-- evaluation, so the volatile gen_random_uuid() cannot be re-run per
-- reference and hand the three statements three different sets of ids.
-- The data-modifying CTEs run to completion even though nothing selects
-- from them, which is what lets one statement do all three writes.
with pairs as materialized (
  select u.id as user_id, extensions.gen_random_uuid() as account_id
  from auth.users u
),
new_accounts as (
  insert into public.customer_accounts (id, stripe_customer_id)
  select
    p.account_id,
    (
      -- Carry the Stripe customer up from whichever of the user's
      -- subscription rows last recorded one.
      select s.stripe_customer_id
      from public.subscriptions s
      where s.user_id = p.user_id and s.stripe_customer_id is not null
      order by s.created_at desc
      limit 1
    )
  from pairs p
  returning id
),
new_members as (
  insert into public.account_members (account_id, user_id, role)
  select p.account_id, p.user_id, 'owner' from pairs p
  returning account_id
)
update public.subscriptions s
set account_id = p.account_id
from pairs p
where s.user_id = p.user_id;

-- A subscription whose user_id no longer resolves to an auth user cannot be
-- attributed to any account and would silently become an orphan with a null
-- account_id, which the NOT NULL below would then fail on with no
-- explanation. Fail loudly here instead, naming the problem.
do $$
declare
  orphaned integer;
begin
  select count(*) into orphaned from public.subscriptions where account_id is null;
  if orphaned > 0 then
    raise exception
      'account backfill left % subscription row(s) with no account — these reference a user_id absent from auth.users and must be resolved before migrating',
      orphaned;
  end if;
end;
$$;

alter table public.subscriptions alter column account_id set not null;

-- ---- drop the old user coupling -------------------------------------
-- The partial unique index that guaranteed "at most one live subscription
-- per user" now has to guarantee it per account.
drop index public.subscriptions_user_active_uniq;
drop index public.subscriptions_user_id_idx;
-- Must go before the column: subscriptions_select_own reads auth.uid() =
-- user_id, so Postgres refuses to drop a column the policy depends on.
-- Ownership is expressed through membership from here on.
drop policy "subscriptions_select_own" on public.subscriptions;
alter table public.subscriptions drop column user_id;
-- Now redundant with customer_accounts.stripe_customer_id, and keeping both
-- would invite them to disagree about which Stripe customer an account is.
alter table public.subscriptions drop column stripe_customer_id;

create index subscriptions_account_id_idx on public.subscriptions (account_id);
create unique index subscriptions_account_active_uniq
  on public.subscriptions (account_id) where status in ('trialing', 'active', 'past_due');

create policy "subscriptions_select_own_account" on public.subscriptions
  for select
  to authenticated
  using (
    account_id in (
      select m.account_id from public.account_members m
      where m.user_id = (select auth.uid())
    )
  );

-- ============================================================
-- Every new user gets an account with themselves as owner, so "a user
-- always has an account" holds from the moment the auth row exists and no
-- endpoint has to lazily create one. A user who signs up to accept an
-- invite still lands here first; invite acceptance moves them, which is why
-- that path checks the account it is abandoning is empty and unbilled.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_account_id uuid;
begin
  insert into public.profiles (id) values (new.id);

  insert into public.customer_accounts default values
    returning id into new_account_id;

  insert into public.account_members (account_id, user_id, role)
    values (new_account_id, new.id, 'owner');

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;
