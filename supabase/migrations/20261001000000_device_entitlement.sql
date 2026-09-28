-- F-01/C-01 (ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md): device
-- capacity was previously enforced independently in several JS call sites
-- (subscriptions.js resolveDeviceEntitlements, account-service.js,
-- identity-lifecycle.js finalizeCreatedIdentity's ad hoc "stillEntitled"),
-- which could disagree -- most concretely, finalizeCreatedIdentity only
-- checked device.status and account membership, never subscription
-- capacity, so a CREATE_USER job that raced past a subscription's device
-- limit (e.g. two concurrent registrations, or a pack downgrade) would be
-- finalized (enabled) regardless of whether the device was actually within
-- its subscription's paid capacity.
--
-- This migration introduces a single SQL function, public.device_entitlement,
-- as the one authoritative answer to "is this device entitled right now,
-- and under which subscription" -- callers in functions/lib no longer
-- decide capacity themselves; they ask this function and honour its answer.
--
-- suspended_at is added here (not only under F-07/C-06) because C-01's
-- definition of entitlement explicitly excludes a suspended account, and a
-- capacity gate that cannot see suspension is not the one true gate the
-- contract requires.

alter table public.customer_accounts
  add column if not exists suspended_at timestamptz;

comment on column public.customer_accounts.suspended_at is
  'Set by admin disable (F-07/C-06). Distinct from deletion_requested_at and '
  'from billing status: a suspended account has no device_entitlement even '
  'while its Stripe subscription stays active, and reconcile must never '
  'clear this on its own.';

-- Rank within a subscription's ACTIVE devices needs a stable "joined this
-- subscription at" timestamp, not devices.created_at, which does not move
-- when a device is moved between subscriptions (moveDevice in
-- account-service.js) -- created_at ordering would let a moved device
-- unfairly outrank one that has been on the target subscription longer, or
-- displace it. subscription_assigned_at is set once here and again on every
-- change of subscription_id.

alter table public.devices
  add column if not exists subscription_assigned_at timestamptz;

update public.devices
   set subscription_assigned_at = created_at
 where subscription_assigned_at is null;

alter table public.devices
  alter column subscription_assigned_at set default now(),
  alter column subscription_assigned_at set not null;

create or replace function public.touch_device_subscription_assigned_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.subscription_id is distinct from old.subscription_id then
    new.subscription_assigned_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists devices_touch_subscription_assigned_at on public.devices;
create trigger devices_touch_subscription_assigned_at
  before insert or update of subscription_id on public.devices
  for each row execute function public.touch_device_subscription_assigned_at();

-- public.device_entitlement(device_id) -> (entitled, subscription_id, reason)
--
-- entitled iff:
--   * the device exists, status = 'ACTIVE';
--   * its account has neither suspended_at nor deletion_requested_at;
--   * either
--       (a) device.subscription_id references a live subscription
--           (status in active/trialing/past_due) of the SAME account, and
--           the device's rank among that subscription's ACTIVE devices,
--           ordered by (subscription_assigned_at, id), is strictly less
--           than 3 x (1 + packs), packs = greatest(extra_seats,0) / 3; or
--       (b) the device has no live subscription of its own, but the account
--           holds an active admin_entitlements grant (support access) and
--           the device's rank among the account's ACTIVE devices with no
--           live subscription, ordered by (subscription_assigned_at, id),
--           is strictly less than the grant's seat_limit.
--
-- Base-item Stripe price validation (C-04/F-31) is intentionally not yet
-- implemented here: subscriptions carries no stripe_price_id column today.
-- Tracked separately; see the remediation report for this branch.
create or replace function public.device_entitlement(p_device_id uuid)
returns table (entitled boolean, subscription_id bigint, reason text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_device record;
  v_account record;
  v_sub record;
  v_rank integer;
  v_capacity integer;
  v_grant record;
begin
  select d.id, d.account_id, d.status, d.subscription_id, d.subscription_assigned_at
    into v_device
    from public.devices d
   where d.id = p_device_id;

  if not found then
    return query select false, null::bigint, 'device_not_found';
    return;
  end if;

  if v_device.status <> 'ACTIVE' then
    return query select false, null::bigint, 'device_revoked';
    return;
  end if;

  select a.id, a.suspended_at, a.deletion_requested_at
    into v_account
    from public.customer_accounts a
   where a.id = v_device.account_id;

  if not found then
    return query select false, null::bigint, 'account_not_found';
    return;
  end if;

  if v_account.suspended_at is not null then
    return query select false, null::bigint, 'account_suspended';
    return;
  end if;

  if v_account.deletion_requested_at is not null then
    return query select false, null::bigint, 'account_deletion_requested';
    return;
  end if;

  if v_device.subscription_id is not null then
    select s.id, s.account_id, s.status, s.extra_seats
      into v_sub
      from public.subscriptions s
     where s.id = v_device.subscription_id;

    if found and v_sub.account_id = v_device.account_id
       and v_sub.status in ('active', 'trialing', 'past_due') then
      select count(*) into v_rank
        from public.devices d2
       where d2.subscription_id = v_sub.id
         and d2.status = 'ACTIVE'
         and (d2.subscription_assigned_at, d2.id) < (v_device.subscription_assigned_at, v_device.id);

      v_capacity := 3 * (1 + (greatest(coalesce(v_sub.extra_seats, 0), 0) / 3));

      if v_rank < v_capacity then
        return query select true, v_sub.id, 'subscription';
        return;
      end if;

      return query select false, v_sub.id, 'over_capacity';
      return;
    end if;
    -- subscription_id set but not live / not this account's own: falls
    -- through to the admin-grant path below, same as an unassigned device.
  end if;

  select g.seat_limit into v_grant
    from public.admin_entitlements g
   where g.account_id = v_device.account_id
     and g.status = 'active'
     and g.starts_at <= now()
     and (g.expires_at is null or g.expires_at > now())
   order by g.created_at desc
   limit 1;

  if not found then
    return query select false, null::bigint, 'no_subscription';
    return;
  end if;

  select count(*) into v_rank
    from public.devices d3
    left join public.subscriptions s3
      on s3.id = d3.subscription_id and s3.status in ('active', 'trialing', 'past_due')
   where d3.account_id = v_device.account_id
     and d3.status = 'ACTIVE'
     and s3.id is null
     and (d3.subscription_assigned_at, d3.id) < (v_device.subscription_assigned_at, v_device.id);

  if v_rank < coalesce(v_grant.seat_limit, 0) then
    return query select true, null::bigint, 'admin_grant';
    return;
  end if;

  return query select false, null::bigint, 'over_capacity';
end;
$$;

revoke all on function public.device_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.device_entitlement(uuid) to service_role;

comment on function public.device_entitlement(uuid) is
  'C-01: the single gate for whether a device may hold/receive a working '
  'VPN credential right now. Callers (assignDeviceProfile, /api/vpn/config, '
  'Telegram device routes, finalizeCreatedIdentity, ensureSessionDevice / '
  'reconcile) must call this instead of re-deriving capacity themselves.';
