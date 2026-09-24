-- Billing model: one person, several subscriptions, devices per subscription.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'one@example.com'),
  ('00000000-0000-4000-8000-0000000000b2', 'two@example.com');

do $$
declare
  a1 uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000a1');
  a2 uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000b2');
  personal bigint;
  family bigint;
  foreign_sub bigint;
  snapshot jsonb;
  rows integer;
begin
  -- Several live subscriptions on one account are allowed now.
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (a1, 'sub_personal', 'active', 'Personal', 0, now() + interval '30 days') returning id into personal;
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (a1, 'sub_family', 'active', 'Family', 3, now() + interval '30 days') returning id into family;
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name)
    values (a2, 'sub_other', 'active', 'Other') returning id into foreign_sub;

  insert into public.devices (account_id, user_id, name, subscription_id)
    values (a1, '00000000-0000-4000-8000-0000000000a1', 'Phone', personal),
           (a1, '00000000-0000-4000-8000-0000000000a1', 'Laptop', family);

  -- A device can never point at another account's subscription.
  begin
    insert into public.devices (account_id, user_id, name, subscription_id)
      values (a1, '00000000-0000-4000-8000-0000000000a1', 'Sneaky', foreign_sub);
    raise exception 'cross-account subscription was accepted';
  exception when check_violation then null;
  end;

  -- Names are required.
  begin
    update public.subscriptions set name = '  ' where id = personal;
    raise exception 'blank name was accepted';
  exception when check_violation then null;
  end;

  -- One app session maps to one device.
  update public.devices set auth_session_id = '00000000-0000-4000-8000-00000000c0de' where name = 'Phone';
  begin
    update public.devices set auth_session_id = '00000000-0000-4000-8000-00000000c0de' where name = 'Laptop';
    raise exception 'duplicate session device was accepted';
  exception when unique_violation then null;
  end;

  select count(*) into rows from public.admin_subscription_directory(null, null, 100, 0)
   where account_id in (a1, a2);
  if rows <> 3 then raise exception 'directory returned % rows', rows; end if;
  select count(*) into rows from public.admin_subscription_directory('one@', null, 50, 0);
  if rows <> 2 then raise exception 'email filter returned % rows', rows; end if;
  if (select device_capacity from public.admin_subscription_directory('Family', null, 50, 0)) <> 6 then
    raise exception 'family capacity wrong';
  end if;

  -- The snapshot counts everything, so compare against the seed baseline:
  -- this test added 3 live subscriptions (capacity 3 + 6 + 3) and 2 devices.
  snapshot := public.admin_device_model_snapshot();
  if (snapshot #>> '{subscriptions,accounts_with_several}')::int < 1 then raise exception 'several %', snapshot; end if;
  if (snapshot #>> '{devices,capacity}')::int < 12 then raise exception 'capacity %', snapshot; end if;
  if (snapshot #>> '{devices,active}')::int < 2 then raise exception 'active %', snapshot; end if;
  delete from public.devices where account_id = a1;
  delete from public.subscriptions where account_id in (a1, a2);
  if (snapshot #>> '{devices,capacity}')::int - (public.admin_device_model_snapshot() #>> '{devices,capacity}')::int <> 12 then
    raise exception 'capacity delta wrong';
  end if;
  if (snapshot #>> '{subscriptions,live}')::int - (public.admin_device_model_snapshot() #>> '{subscriptions,live}')::int <> 3 then
    raise exception 'live delta wrong';
  end if;
end $$;

-- Admin functions are not callable by customers.
set local role authenticated;
do $$
begin
  perform public.admin_device_model_snapshot();
  raise exception 'authenticated could call admin_device_model_snapshot';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
