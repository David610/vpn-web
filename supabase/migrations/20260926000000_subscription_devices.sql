-- Billing model: one person per account, any number of subscriptions, and
-- device capacity per subscription.
--
-- Before: an account had at most one live subscription and paid for SEATS
-- (people); every member could run several devices.
-- After:  an account is one person. Each subscription covers 3 devices plus
--         3 more per paid pack, and every device belongs to at most one
--         subscription. A person can hold several subscriptions (for example
--         "Personal" and "Family").
--
-- subscriptions.extra_seats keeps its name (it is the Stripe pack item's
-- mirror in units, packs x 3 — see seat-constants.js) but now counts extra
-- DEVICES, so capacity = 3 + extra_seats.

alter table public.subscriptions
  add column name text not null default 'Personal'
    check (char_length(btrim(name)) between 1 and 80);

comment on column public.subscriptions.extra_seats is
  'Extra device capacity beyond the 3 included: Stripe pack quantity x 3.';

-- Several live subscriptions per account are now allowed.
drop index if exists public.subscriptions_account_active_uniq;
create index subscriptions_account_status_idx
  on public.subscriptions (account_id, status);

alter table public.devices
  add column subscription_id bigint references public.subscriptions (id) on delete set null;
create index devices_subscription_id_idx on public.devices (subscription_id);

-- Existing active devices join their account's oldest live subscription.
-- Devices beyond its capacity stay assigned and are simply not entitled
-- (the reconciler enforces capacity in created_at order), so nothing a
-- customer set up disappears; they can move or remove devices themselves.
update public.devices d
   set subscription_id = s.id
  from (
    select distinct on (account_id) id, account_id
      from public.subscriptions
     where status in ('trialing', 'active', 'past_due')
     order by account_id, created_at
  ) s
 where d.account_id = s.account_id
   and d.status = 'ACTIVE'
   and d.subscription_id is null;

-- A device may only point at a subscription of its own account.
create function public.enforce_device_subscription_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subscription_id is not null and not exists (
    select 1 from public.subscriptions s
     where s.id = new.subscription_id and s.account_id = new.account_id
  ) then
    raise exception 'device subscription belongs to another account'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger devices_subscription_account_guard
  before insert or update of subscription_id, account_id on public.devices
  for each row execute function public.enforce_device_subscription_account();

-- New people can no longer be invited onto an account. Existing members
-- keep working; pending invitations are withdrawn.
update public.member_invites
   set revoked_at = now()
 where accepted_at is null and revoked_at is null;

-- The Arcana app signs in per device: the Supabase auth session that a
-- device's app holds maps to exactly one devices row, so "this device"
-- (rename it, log it out) is unambiguous and never inferred from the client.
alter table public.devices add column auth_session_id uuid unique;

-- Account deletion is two-phase so no VPN credential outlives it: the
-- request bans sign-in, cancels billing and disables every device identity;
-- finalizeAccountDeletions() removes the auth user (cascading everything)
-- only once no identity is enabled and no job is still pending.
alter table public.customer_accounts add column deletion_requested_at timestamptz;
create index customer_accounts_deletion_idx
  on public.customer_accounts (deletion_requested_at)
  where deletion_requested_at is not null;
