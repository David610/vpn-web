-- F-40 (ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md):
-- `past_due` previously counted as live for entitlement purposes forever --
-- there was no cap at all, so a subscription that never recovered from
-- dunning kept full service indefinitely. This migration adds the
-- transition timestamp public.device_entitlement() (and its JS counterparts
-- in functions/lib/accounts.js / subscriptions.js / stripe-fields.js) need
-- to bound that window, and rewrites device_entitlement() itself to apply
-- the same bound -- this is the SQL half of the fix; the JS half lives in
-- accounts.js's getLiveSubscription() and subscriptions.js's isLive().
--
-- Not edited in place: 20261001000000_device_entitlement.sql and
-- 20261002000000_device_entitlement_assignment_order.sql (which most
-- recently redefined this function, switching capacity ranking to the
-- sequence-backed subscription_assignment_seq), per the repo's rule
-- against editing already-merged migrations. This CREATE OR REPLACE layers
-- on top of that definition, keeping its ranking column and every other
-- rule unchanged, and only adds the past_due bound.

alter table public.subscriptions
  add column if not exists past_due_since timestamptz;

comment on column public.subscriptions.past_due_since is
  'F-40: when this row FIRST transitioned to status=past_due (set/cleared by '
  'the customer.subscription.updated / invoice.paid webhook handlers in '
  'functions/lib/stripe-events.js). Null while not past_due, and null for a '
  'legacy row that went past_due before this column existed. Used to bound '
  'how long past_due keeps counting as live -- see device_entitlement()''s '
  'v_past_due_grace and functions/lib/stripe-fields.js''s '
  'DEFAULT_PAST_DUE_GRACE_MS (kept at the same 14-day default; the JS side '
  'additionally accepts an env.PAST_DUE_GRACE_MS override, which this SQL '
  'function -- having no access to that env -- cannot honor, so the two can '
  'diverge if that env var is ever set. That is accepted here: this RPC is '
  'the device-capacity gate, which is conservative to run slightly out of '
  'sync with a rarely-changed override, not the primary entitlement/billing '
  'display path, which always runs through the JS helper and therefore '
  'always sees the override.';

-- Best-effort backfill: a row already sitting in past_due right now has no
-- recorded transition time, so treat "now" as its past_due_since -- this
-- starts its grace window from the moment this migration runs rather than
-- leaving it with a null (which the entitlement code treats as "still
-- within grace", i.e. unbounded) forever. A row that recovers or goes
-- terminal afterward clears/ignores this as normal.
update public.subscriptions
   set past_due_since = now()
 where status = 'past_due'
   and past_due_since is null;

-- Re-create device_entitlement exactly as
-- 20261002000000_device_entitlement_assignment_order.sql left it (same
-- signature, same subscription_assignment_seq-based ranking), adding only
-- the past_due bound to both places that matched
-- `status in ('active', 'trialing', 'past_due')`.
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
  -- F-40: kept at the same 14-day default as
  -- functions/lib/stripe-fields.js's DEFAULT_PAST_DUE_GRACE_MS -- see this
  -- migration's header/column comment for why this constant can't read
  -- env.PAST_DUE_GRACE_MS the way the JS side can.
  v_past_due_grace interval := interval '14 days';
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
    select s.id, s.account_id, s.status, s.extra_seats, s.past_due_since
      into v_sub
      from public.subscriptions s
     where s.id = v_device.subscription_id;

    if found and v_sub.account_id = v_device.account_id
       and (
         v_sub.status in ('active', 'trialing')
         or (
           v_sub.status = 'past_due'
           and (v_sub.past_due_since is null or now() - v_sub.past_due_since < v_past_due_grace)
         )
       ) then
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

    if found and v_sub.account_id = v_device.account_id and v_sub.status = 'past_due' then
      return query select false, v_sub.id, 'past_due_grace_expired';
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
      on s3.id = d3.subscription_id
     and (
       s3.status in ('active', 'trialing')
       or (
         s3.status = 'past_due'
         and (s3.past_due_since is null or now() - s3.past_due_since < v_past_due_grace)
       )
     )
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
  'so it is deterministic under batch insert and concurrent transactions. '
  'F-40: a subscription stuck in past_due for longer than v_past_due_grace '
  '(14 days) is treated the same as one that lapsed -- see '
  '20261009000000_past_due_grace.sql.';
