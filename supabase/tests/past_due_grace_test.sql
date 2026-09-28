-- F-40: device_entitlement() must bound how long a past_due subscription
-- keeps granting entitlement, instead of treating past_due as live forever.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'pastdue-one@example.com');

do $$
declare
  a1 uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000f1');
  sub_a bigint;
  d1 uuid;
  r record;
begin
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end, past_due_since)
    values (a1, 'sub_pd', 'past_due', 'PD', 0, now() + interval '30 days', now() - interval '1 day')
    returning id into sub_a;

  insert into public.devices (account_id, user_id, name, subscription_id) values
    (a1, '00000000-0000-4000-8000-0000000000f1', 'd1', sub_a) returning id into d1;

  -- 1) past_due within the grace window (1 day ago, well under 14) is still
  --    entitled, same as active/trialing.
  select * into r from public.device_entitlement(d1);
  if not r.entitled then raise exception 'past_due within grace should be entitled, got reason %', r.reason; end if;
  if r.reason <> 'subscription' then raise exception 'wrong reason: %', r.reason; end if;

  -- 2) past_due well beyond the grace window (20 days ago) is no longer
  --    entitled, even though the row's status string still reads past_due.
  update public.subscriptions set past_due_since = now() - interval '20 days' where id = sub_a;
  select * into r from public.device_entitlement(d1);
  if r.entitled then raise exception 'past_due beyond grace window was entitled'; end if;
  if r.reason <> 'past_due_grace_expired' then raise exception 'wrong reason for expired grace: %', r.reason; end if;

  -- 3) recovering to active (a payment succeeding) restores entitlement
  --    immediately and unconditionally, regardless of how long it had been
  --    past_due -- bounding UNPAID risk must never punish an eventual
  --    successful payment.
  update public.subscriptions set status = 'active', past_due_since = null where id = sub_a;
  select * into r from public.device_entitlement(d1);
  if not r.entitled then raise exception 'recovered (active) subscription should be entitled'; end if;

  -- 4) a past_due row with no past_due_since recorded (legacy data, or a
  --    transition that predates this column) fails OPEN -- still entitled,
  --    exactly like an unbounded past_due used to be, rather than instantly
  --    cutting off a row this function cannot actually date.
  update public.subscriptions set status = 'past_due', past_due_since = null where id = sub_a;
  select * into r from public.device_entitlement(d1);
  if not r.entitled then raise exception 'past_due with no past_due_since should fail open (entitled)'; end if;

  delete from public.devices where account_id = a1;
  delete from public.subscriptions where account_id = a1;
end $$;

rollback;
