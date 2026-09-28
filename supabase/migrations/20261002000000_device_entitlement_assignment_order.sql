-- Fixes a real non-determinism bug in 20261001000000_device_entitlement.sql's
-- capacity ranking: it orders devices by (subscription_assigned_at, id).
-- subscription_assigned_at defaults to now(), and Postgres freezes now() for
-- the whole transaction, so any batch that inserts/reassigns more than one
-- device in a single transaction (bulk import, admin tooling, or two racing
-- requests that happen to land in the same transaction) gives those devices
-- an IDENTICAL timestamp. The tie-break then falls to `id`, a random UUID,
-- so who gets the Nth paid slot becomes non-deterministic instead of FIFO.
-- Reproduced by supabase/tests/device_entitlement_test.sql failing ~2/3 runs.
--
-- Fix: a sequence-backed ordinal. nextval() is NOT transactional -- it is
-- assigned the instant the statement runs and never repeats, even for two
-- rows inserted in the same statement or the same transaction, and even
-- under concurrent transactions (sequence advancement doesn't wait on other
-- transactions' locks). That gives a strict, deterministic, database-owned
-- assignment order with no wall-clock dependency.
--
-- subscription_assigned_at is kept (admin UI / display uses "when did this
-- device join its plan"); it is no longer part of the entitlement ranking.

create sequence if not exists public.device_subscription_assignment_seq;

alter table public.devices
  add column if not exists subscription_assignment_seq bigint;

-- Backfill preserving today's relative order: assign seq values in the same
-- order the old (subscription_assigned_at, id) tie-break would have used, so
-- no existing device changes rank relative to its current subscription-mates
-- as a side effect of this migration. An explicit per-row loop (rather than
-- a single UPDATE ... FROM with a window-generated offset) is used because
-- SQL gives no guarantee about how many times a volatile function like
-- nextval() is evaluated inside a single statement's plan.
do $$
declare
  r record;
begin
  for r in
    select id
      from public.devices
     order by subscription_assigned_at, id
  loop
    update public.devices
       set subscription_assignment_seq = nextval('public.device_subscription_assignment_seq')
     where id = r.id
       and subscription_assignment_seq is null;
  end loop;
end;
$$;

alter table public.devices
  alter column subscription_assignment_seq set default nextval('public.device_subscription_assignment_seq'),
  alter column subscription_assignment_seq set not null;

alter sequence public.device_subscription_assignment_seq owned by public.devices.subscription_assignment_seq;

create unique index if not exists devices_subscription_assignment_seq_key
  on public.devices (subscription_assignment_seq);

create or replace function public.touch_device_subscription_assigned_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.subscription_id is distinct from old.subscription_id then
    new.subscription_assigned_at := now();
    new.subscription_assignment_seq := nextval('public.device_subscription_assignment_seq');
  end if;
  return new;
end;
$$;

-- Trigger definition (name/timing/columns) is unchanged; only the function
-- body above changed, so no need to drop/recreate the trigger itself.

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
  select d.id, d.account_id, d.status, d.subscription_id, d.subscription_assignment_seq
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
         and d2.subscription_assignment_seq < v_device.subscription_assignment_seq;

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
     and d3.subscription_assignment_seq < v_device.subscription_assignment_seq;

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
  'reconcile) must call this instead of re-deriving capacity themselves. '
  'Ranking uses subscription_assignment_seq (a sequence, not a timestamp) '
  'so it is deterministic under batch insert and concurrent transactions.';

comment on column public.devices.subscription_assignment_seq is
  'Deterministic FIFO ordinal for device_entitlement() capacity ranking '
  'within a subscription (or within an admin-grant account). Set from '
  'device_subscription_assignment_seq on insert and on every change of '
  'subscription_id. Unlike subscription_assigned_at (a timestamp, kept for '
  'display), this is never equal for two different rows, even inserted in '
  'the same transaction, because nextval() is not transactional.';
