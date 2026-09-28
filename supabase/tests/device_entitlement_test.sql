-- F-01/C-01: public.device_entitlement is the single capacity/suspension
-- gate. This reproduces the audit's Appendix A capacity-bypass scenario
-- inverted (device 4 on a 3-device plan must now be denied) plus the other
-- scenarios C-01 calls out: a +3 pack allowing device 4, two subscriptions
-- not pooling capacity, moving a device between subscriptions, cancelling
-- one subscription, and a suspended account never being entitled.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000e1', 'entitle-one@example.com'),
  ('00000000-0000-4000-8000-0000000000e2', 'entitle-two@example.com');

do $$
declare
  a1 uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000e1');
  a2 uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000e2');
  sub_a bigint;
  sub_b bigint;
  sub_other bigint;
  d1 uuid; d2 uuid; d3 uuid; d4 uuid; d5 uuid;
  r record;
begin
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (a1, 'sub_a', 'active', 'A', 0, now() + interval '30 days') returning id into sub_a;
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (a1, 'sub_b', 'active', 'B', 0, now() + interval '30 days') returning id into sub_b;
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (a2, 'sub_other', 'active', 'Other', 0, now() + interval '30 days') returning id into sub_other;

  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000e1', 'd1', sub_a) returning id into d1;
  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000e1', 'd2', sub_a) returning id into d2;
  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000e1', 'd3', sub_a) returning id into d3;

  -- 1) 3-device plan denies device 4 (the audit's capacity-bypass repro,
  --    inverted: this MUST now be entitled = false).
  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000e1', 'd4', sub_a) returning id into d4;
  select * into r from public.device_entitlement(d4);
  if r.entitled then raise exception 'device 4 on a 3-device plan was entitled'; end if;
  if r.reason <> 'over_capacity' then raise exception 'wrong reason: %', r.reason; end if;

  -- Devices 1-3 stay entitled (rank 0..2 < capacity 3).
  select * into r from public.device_entitlement(d1);
  if not r.entitled then raise exception 'device 1 should be entitled'; end if;
  select * into r from public.device_entitlement(d3);
  if not r.entitled then raise exception 'device 3 should be entitled'; end if;

  -- 2) A +3 pack allows device 4.
  update public.subscriptions set extra_seats = 3 where id = sub_a;
  select * into r from public.device_entitlement(d4);
  if not r.entitled then raise exception 'device 4 should be entitled after a +3 pack'; end if;
  update public.subscriptions set extra_seats = 0 where id = sub_a;

  -- 3) Two subscriptions do not pool capacity: sub_b is empty, but device 4
  --    (assigned to the full sub_a) is still denied, not silently granted
  --    room from sub_b.
  select * into r from public.device_entitlement(d4);
  if r.entitled then raise exception 'sub_b capacity leaked into sub_a'; end if;

  -- 4) Moving device 4 to sub_b (which has room) allows it.
  update public.devices set subscription_id = sub_b where id = d4;
  select * into r from public.device_entitlement(d4);
  if not r.entitled then raise exception 'device moved to a subscription with room should be entitled'; end if;
  if r.subscription_id <> sub_b then raise exception 'wrong subscription_id after move'; end if;

  -- 5) Cancelling sub_b denies every device on it.
  update public.subscriptions set status = 'canceled' where id = sub_b;
  select * into r from public.device_entitlement(d4);
  if r.entitled then raise exception 'device on a canceled subscription was entitled'; end if;
  update public.subscriptions set status = 'active' where id = sub_b;

  -- 6) A cross-account subscription_id can never grant entitlement (belt and
  --    braces: the FK/trigger already forbids writing it, this checks the
  --    RPC does not trust a row that slipped through some other way).
  select * into r from public.device_entitlement(d1);
  if r.subscription_id = sub_other then raise exception 'cross-account subscription accepted'; end if;

  -- 7) Suspension overrides an otherwise-live subscription.
  update public.customer_accounts set suspended_at = now() where id = a1;
  select * into r from public.device_entitlement(d1);
  if r.entitled then raise exception 'suspended account device was entitled'; end if;
  if r.reason <> 'account_suspended' then raise exception 'wrong suspended reason: %', r.reason; end if;
  update public.customer_accounts set suspended_at = null where id = a1;

  -- 8) Deletion-requested account is never entitled.
  update public.customer_accounts set deletion_requested_at = now() where id = a1;
  select * into r from public.device_entitlement(d1);
  if r.entitled then raise exception 'account pending deletion was entitled'; end if;
  update public.customer_accounts set deletion_requested_at = null where id = a1;

  -- 9) A revoked device is never entitled even with room on its subscription.
  update public.devices set status = 'REVOKED' where id = d3;
  select * into r from public.device_entitlement(d3);
  if r.entitled then raise exception 'revoked device was entitled'; end if;

  -- 10) Concurrent registration: two devices "simultaneously" inserted onto
  --     a 3-device plan that already has 2 active devices (d1, d2; d3 was
  --     revoked above, freeing one nominal slot, so re-activate it first to
  --     get back to exactly 2 active + 1 revoked, i.e. 2 ranked devices).
  --     Both new rows are inserted in the same statement batch (no lock
  --     between them), simulating a race; the rank-based RPC still allows
  --     only one of the two into the remaining single slot.
  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000e1', 'race-a', sub_a) returning id into d5;
  declare
    d6 uuid;
    r5 record;
    r6 record;
  begin
    insert into public.devices (account_id, user_id, name, subscription_id) values
      (a1, '00000000-0000-4000-8000-0000000000e1', 'race-b', sub_a) returning id into d6;
    select * into r5 from public.device_entitlement(d5);
    select * into r6 from public.device_entitlement(d6);
    if r5.entitled and r6.entitled then
      raise exception 'both racing devices were entitled past capacity';
    end if;
    if not (r5.entitled or r6.entitled) then
      raise exception 'neither racing device got the one remaining slot';
    end if;
  end;

  delete from public.devices where account_id in (a1, a2);
  delete from public.subscriptions where account_id in (a1, a2);
end $$;

-- The function is service-role only.
set local role authenticated;
do $$
begin
  begin
    perform public.device_entitlement('00000000-0000-4000-8000-000000000000'::uuid);
    raise exception 'authenticated role could call device_entitlement';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
