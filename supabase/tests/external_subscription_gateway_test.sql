-- Phase 2.5 external subscription/control-plane invariants.
-- Runs after all migrations + seed in scripts/test-supabase-sql.sh.
begin;

insert into auth.users (id, email) values
  ('30000000-0000-4000-8000-000000000001', 'external-a@example.com'),
  ('30000000-0000-4000-8000-000000000002', 'external-b@example.com');

insert into public.nodes(node_id, api_key_hash, lifecycle_state) values
  ('ext-node-a', repeat('a', 64), 'READY'),
  ('ext-node-b', repeat('b', 64), 'READY');

insert into public.logical_routes(id, region, privacy_class, display_name, enabled)
values
  ('route_extfast', 'de', 'fast', 'Germany Fast', true),
  ('route_no_target', 'nl', 'fast', 'Netherlands Fast', true);

insert into public.logical_route_targets(route_id, hop, node_id, priority, enabled)
values ('route_extfast', 1, 'ext-node-a', 100, true);

do $$
declare
  a1 uuid := (select account_id from public.account_members
    where user_id='30000000-0000-4000-8000-000000000001');
  a2 uuid := (select account_id from public.account_members
    where user_id='30000000-0000-4000-8000-000000000002');  sub1 bigint;
  sub2 bigint;
  dev uuid;
  before_token text;
  before_devices integer;
  c integer;
begin
  insert into public.subscriptions(account_id,status,name,extra_seats,current_period_end)
  values(a1,'active','External test',0,now()+interval '30 days') returning id into sub1;
  insert into public.subscriptions(account_id,status,name,extra_seats,current_period_end)
  values(a2,'canceled','Inactive test',0,now()+interval '30 days') returning id into sub2;

  insert into public.devices(account_id,user_id,name,platform,status,subscription_id)
  values
    (a1,'30000000-0000-4000-8000-000000000001','Existing 1','other','ACTIVE',sub1),
    (a1,'30000000-0000-4000-8000-000000000001','Existing 2','other','ACTIVE',sub1);

  dev := public.create_external_vpn_device(
    a1,'30000000-0000-4000-8000-000000000001',sub1,'External final seat',
    'singbox','ext_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',repeat('1',64),
    'route_extfast','cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'cipher-a','nonce-a',now()+interval '7 days');

  if dev is null then raise exception 'external device was not created'; end if;
  if (select count(*) from public.devices where subscription_id=sub1 and status='ACTIVE') <> 3 then
    raise exception 'final included seat was not allocated exactly once';
  end if;  if (select published from public.logical_route_targets
      where route_id='route_extfast' and node_id='ext-node-a') then
    raise exception 'target published before live node acknowledgement';
  end if;
  if not exists (select 1 from public.compatibility_authorizations
      where node_id='ext-node-a'
        and credential_id='cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        and loaded_at is null and revoked=false) then
    raise exception 'initial compatibility authorization was not projected pending';
  end if;

  perform public.ack_compatibility_authorizations(
    'ext-node-a', array['cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  if not (select published from public.logical_route_targets
      where route_id='route_extfast' and node_id='ext-node-a') then
    raise exception 'target did not publish after live acknowledgement';
  end if;

  begin
    perform public.create_external_vpn_device(
      a1,'30000000-0000-4000-8000-000000000001',sub1,'Seat overflow',
      'singbox','ext_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',repeat('2',64),
      'route_extfast','cred_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cipher-b','nonce-b',now()+interval '7 days');
    raise exception 'seat overflow was accepted';
  exception when others then
    if sqlerrm not like '%seats_full%' then raise; end if;
  end;  begin
    perform public.create_external_vpn_device(
      a2,'30000000-0000-4000-8000-000000000002',sub1,'Wrong account',
      'singbox','ext_cccccccccccccccccccccccccccccccc',repeat('3',64),
      'route_extfast','cred_cccccccccccccccccccccccccccccccc',
      'cipher-c','nonce-c',now()+interval '7 days');
    raise exception 'wrong account subscription was accepted';
  exception when others then
    if sqlerrm not like '%subscription_not_entitled%' then raise; end if;
  end;

  begin
    perform public.create_external_vpn_device(
      a2,'30000000-0000-4000-8000-000000000002',sub2,'Inactive',
      'singbox','ext_dddddddddddddddddddddddddddddddd',repeat('4',64),
      'route_extfast','cred_dddddddddddddddddddddddddddddddd',
      'cipher-d','nonce-d',now()+interval '7 days');
    raise exception 'inactive subscription was accepted';
  exception when others then
    if sqlerrm not like '%subscription_not_entitled%' then raise; end if;
  end;

  if not public.rotate_compatibility_credential(
      dev,a1,'cred_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','cipher-e','nonce-e',
      now()+interval '7 days',172800) then
    raise exception 'A/B rotation returned false';
  end if;  select count(*) into c from public.compatibility_credentials
    where device_id=dev and revoked_at is null and valid_until>now();
  if c <> 2 then raise exception 'A/B rotation expected 2 live credentials, got %', c; end if;
  if not exists (select 1 from public.compatibility_authorizations
      where node_id='ext-node-a'
        and credential_id='cred_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        and loaded_at is null and revoked=false) then
    raise exception 'B credential was not projected pending';
  end if;

  begin
    perform public.rotate_compatibility_credential(
      dev,a1,'cred_ffffffffffffffffffffffffffffffff','cipher-f','nonce-f',
      now()+interval '7 days',172800);
    raise exception 'third live credential was accepted';
  exception when others then
    if sqlerrm not like '%compatibility_credential_limit%' then raise; end if;
  end;

  begin
    perform public.rotate_compatibility_credential(
      dev,a1,'cred_gggggggggggggggggggggggggggggggg','cipher-g','nonce-g',
      now()+interval '7 days',172801);
    raise exception 'overlap above 48h was accepted';
  exception when others then
    if sqlerrm not like '%invalid_overlap%' then raise; end if;
  end;  insert into public.logical_route_targets(route_id,hop,node_id,priority,enabled)
  values ('route_extfast',1,'ext-node-b',50,true);
  if (select published from public.logical_route_targets
      where route_id='route_extfast' and node_id='ext-node-b') then
    raise exception 'new migration target published before credentials were live';
  end if;
  select count(*) into c from public.compatibility_authorizations
    where logical_route_id='route_extfast' and node_id='ext-node-b'
      and revoked=false and valid_until>now();
  if c <> 2 then raise exception 'new target did not receive both A/B credentials, got %', c; end if;

  perform public.ack_compatibility_authorizations(
    'ext-node-b',
    array[
      'cred_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cred_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ]);
  if not (select published from public.logical_route_targets
      where route_id='route_extfast' and node_id='ext-node-b') then
    raise exception 'new target did not publish after both credentials loaded';
  end if;

  update public.logical_route_targets set enabled=false
    where route_id='route_extfast' and node_id='ext-node-a';
  if exists (select 1 from public.compatibility_authorizations
      where logical_route_id='route_extfast' and node_id='ext-node-a' and revoked=false) then
    raise exception 'old target authorization remained active after break step';
  end if;  select subscription_token_hash into before_token
    from public.external_vpn_devices where device_id=dev;
  if not public.revoke_external_vpn_device(dev,a1) then
    raise exception 'device revoke returned false';
  end if;
  if (select subscription_token_hash from public.external_vpn_devices where device_id=dev) = before_token then
    raise exception 'subscription token hash was not invalidated on revoke';
  end if;
  if exists (select 1 from public.compatibility_authorizations
      where principal_id='ext_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' and revoked=false) then
    raise exception 'revocation did not revoke node projections';
  end if;
  if (select status from public.devices where id=dev) <> 'REVOKED'
     or (select subscription_id from public.devices where id=dev) is not null then
    raise exception 'revocation did not release the subscription seat';
  end if;

  select count(*) into before_devices from public.devices where account_id=a1;
  begin
    perform public.create_external_vpn_device(
      a1,'30000000-0000-4000-8000-000000000001',sub1,'No route target',
      'singbox','ext_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh',repeat('5',64),
      'route_no_target','cred_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh',
      'cipher-h','nonce-h',now()+interval '7 days');
    raise exception 'route_unavailable creation was accepted';
  exception when others then
    if sqlerrm not like '%route_unavailable%' then raise; end if;
  end;
  if (select count(*) from public.devices where account_id=a1) <> before_devices then
    raise exception 'route_unavailable did not roll back the base device insert';
  end if;

  -- Base 3 seats plus 3/6/9 extra seats must admit exactly 3/6/9/12
  -- active devices respectively, with the next allocation rejected.
  declare
    extra integer;
    cap integer;
    u uuid;
    acct uuid;
    s bigint;
    final_device uuid;
    token_hash text;
  begin
    foreach extra in array array[0,3,6,9] loop
      u := extensions.gen_random_uuid();
      insert into auth.users(id,email)
        values(u, 'pack-' || extra || '-' || u::text || '@example.com');
      select account_id into acct from public.account_members where user_id=u;
      insert into public.subscriptions(account_id,status,name,extra_seats,current_period_end)
        values(acct,'active','Pack ' || extra,extra,now()+interval '30 days')
        returning id into s;
      cap := 3 + extra;
      insert into public.devices(account_id,user_id,name,status,subscription_id)
        select acct,u,'existing-' || g,'ACTIVE',s from generate_series(1,cap-1) g;
      token_hash := replace(extensions.gen_random_uuid()::text,'-','')
                 || replace(extensions.gen_random_uuid()::text,'-','');
      final_device := public.create_external_vpn_device(
        acct,u,s,'pack-final','singbox',
        'ext_' || replace(extensions.gen_random_uuid()::text,'-',''),
        token_hash,'route_extfast',
        'cred_' || replace(extensions.gen_random_uuid()::text,'-',''),
        'cipher-pack','nonce-pack',now()+interval '7 days');
      if final_device is null or
         (select count(*) from public.devices where subscription_id=s and status='ACTIVE') <> cap then
        raise exception 'extra_seats % did not produce exact capacity %', extra, cap;
      end if;
      begin
        perform public.create_external_vpn_device(
          acct,u,s,'pack-overflow','singbox',
          'ext_' || replace(extensions.gen_random_uuid()::text,'-',''),
          replace(extensions.gen_random_uuid()::text,'-','') || replace(extensions.gen_random_uuid()::text,'-',''),
          'route_extfast','cred_' || replace(extensions.gen_random_uuid()::text,'-',''),
          'cipher-over','nonce-over',now()+interval '7 days');
        raise exception 'extra_seats % accepted device beyond capacity %', extra, cap;
      exception when others then
        if sqlerrm not like '%seats_full%' then raise; end if;
      end;
    end loop;
  end;
end $$;

rollback;

-- Concurrent final-seat serialization: two independent sessions race for
-- one remaining slot. Exactly one must commit.
create extension if not exists dblink;

insert into auth.users (id,email)
values ('30000000-0000-4000-8000-000000000003','external-race@example.com');
insert into public.nodes(node_id,api_key_hash,lifecycle_state)
values ('ext-node-race',repeat('c',64),'READY');
insert into public.logical_routes(id,region,privacy_class,display_name,enabled)
values ('route_race','fr','fast','France Fast',true);
insert into public.logical_route_targets(route_id,hop,node_id,priority,enabled)
values ('route_race',1,'ext-node-race',100,true);

insert into public.subscriptions(account_id,status,name,extra_seats,current_period_end)
select account_id,'active','Race',0,now()+interval '30 days'
from public.account_members
where user_id='30000000-0000-4000-8000-000000000003';

insert into public.devices(account_id,user_id,name,status,subscription_id)
select m.account_id,m.user_id,v.name,'ACTIVE',s.id
from public.account_members m
join public.subscriptions s on s.account_id=m.account_id and s.name='Race'
cross join (values ('Race existing 1'),('Race existing 2')) as v(name)
where m.user_id='30000000-0000-4000-8000-000000000003';

do $$
declare
  acct uuid := (select account_id from public.account_members
    where user_id='30000000-0000-4000-8000-000000000003');
  sub_id bigint := (select s.id from public.subscriptions s
    join public.account_members m on m.account_id=s.account_id
    where m.user_id='30000000-0000-4000-8000-000000000003' and s.name='Race');
  q1 text;
  q2 text;
  successes integer := 0;
  failures integer := 0;
  err1 text := '';
  err2 text := '';
begin
  perform dblink_connect('race1','dbname=' || current_database());
  perform dblink_connect('race2','dbname=' || current_database());
  q1 := format(
    'select public.create_external_vpn_device(%L::uuid,%L::uuid,%s,%L,%L,%L,%L,%L,%L,%L,%L,now()+interval ''7 days'')',
    acct,'30000000-0000-4000-8000-000000000003',sub_id,'Race A','singbox',
    'ext_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',repeat('6',64),'route_race',
    'cred_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr','cipher-r1','nonce-r1');
  q2 := format(
    'select public.create_external_vpn_device(%L::uuid,%L::uuid,%s,%L,%L,%L,%L,%L,%L,%L,%L,now()+interval ''7 days'')',
    acct,'30000000-0000-4000-8000-000000000003',sub_id,'Race B','singbox',
    'ext_ssssssssssssssssssssssssssssssss',repeat('7',64),'route_race',
    'cred_ssssssssssssssssssssssssssssssss','cipher-r2','nonce-r2');
  perform dblink_send_query('race1',q1);
  perform dblink_send_query('race2',q2);
  begin
    perform * from dblink_get_result('race1') as t(device_id uuid);
    successes := successes + 1;
  exception when others then
    failures := failures + 1;
    err1 := sqlerrm;
  end;
  begin
    perform * from dblink_get_result('race2') as t(device_id uuid);
    successes := successes + 1;
  exception when others then
    failures := failures + 1;
    err2 := sqlerrm;
  end;
  perform dblink_disconnect('race1');
  perform dblink_disconnect('race2');

  if successes <> 1 or failures <> 1 then
    raise exception 'concurrent final-seat race expected 1 success/1 failure, got %/%; errors: [%] [%]',
      successes, failures, err1, err2;
  end if;
  if (select count(*) from public.devices where subscription_id=sub_id and status='ACTIVE') <> 3 then
    raise exception 'concurrent final-seat race oversubscribed capacity';
  end if;
end $$;

-- New protected tables and SECURITY DEFINER RPCs are service-only.
begin;
set local role authenticated;
do $$
begin
  perform count(*) from public.external_vpn_devices;
  raise exception 'authenticated could read external_vpn_devices';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform public.ack_compatibility_authorizations('ext-node-race',array[]::text[]);
  raise exception 'authenticated could execute authorization ack';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role anon;
do $$
begin
  perform count(*) from public.compatibility_credentials;
  raise exception 'anon could read compatibility_credentials';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  perform count(*) from public.compatibility_authorizations;
  raise exception 'anon could read compatibility_authorizations';
exception when insufficient_privilege then null;
end $$;
rollback;