-- Real two-session races for Link capacity and idempotent allocation.
create extension if not exists dblink;

insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('link-race-node',repeat('7',64),'00000000-0000-4000-8000-000000000000','READY','mock','link-race.example.test');
insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_link_race','race','fast','Link race');
insert into public.logical_route_targets(route_id,hop,node_id) values ('route_link_race',1,'link-race-node');
insert into public.subscriptions(id,account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
overriding system value
select 900000010,account_id,'sub_link_race','active','Link race',0,now()+interval '30 days'
from public.account_members where user_id='11111111-1111-1111-1111-111111111111';

insert into public.vpn_links(id,account_id,name,desired_route_id,max_clients)
select '10000000-0000-4000-8000-000000000001',account_id,'One slot','route_link_race',1
from public.account_members where user_id='11111111-1111-1111-1111-111111111111';

select dblink_connect('link-cap-1','dbname='||current_database());
select dblink_connect('link-cap-2','dbname='||current_database());
select dblink_send_query('link-cap-1',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000001',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Cap A','singbox',repeat('1',64),
    'ext_'||repeat('a',43),repeat('2',64),'cred_'||repeat('a',43),'cipher-a','nonce-a',now()+interval '7 days')
$q$);
select dblink_send_query('link-cap-2',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000001',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Cap B','singbox',repeat('3',64),
    'ext_'||repeat('b',43),repeat('4',64),'cred_'||repeat('b',43),'cipher-b','nonce-b',now()+interval '7 days')
$q$);
select * from dblink_get_result('link-cap-1',false) as t(device_id uuid);
select * from dblink_get_result('link-cap-2',false) as t(device_id uuid);
select dblink_disconnect('link-cap-1');
select dblink_disconnect('link-cap-2');

do $$ begin
  assert (select count(*) from public.external_vpn_devices where link_id='10000000-0000-4000-8000-000000000001')=1,
    'concurrent calls exceeded Link capacity';
end $$;

insert into public.vpn_links(id,account_id,name,desired_route_id,max_clients)
select '10000000-0000-4000-8000-000000000002',account_id,'Idempotent race','route_link_race',2
from public.account_members where user_id='11111111-1111-1111-1111-111111111111';
select dblink_connect('link-idem-1','dbname='||current_database());
select dblink_connect('link-idem-2','dbname='||current_database());
select dblink_send_query('link-idem-1',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000002',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Idem A','singbox',repeat('5',64),
    'ext_'||repeat('c',43),repeat('6',64),'cred_'||repeat('c',43),'cipher-c','nonce-c',now()+interval '7 days')
$q$);
select dblink_send_query('link-idem-2',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000002',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Idem retry','singbox',repeat('5',64),
    'ext_'||repeat('d',43),repeat('7',64),'cred_'||repeat('d',43),'cipher-d','nonce-d',now()+interval '7 days')
$q$);
select * from dblink_get_result('link-idem-1',false) as t(device_id uuid);
select * from dblink_get_result('link-idem-2',false) as t(device_id uuid);
select dblink_disconnect('link-idem-1');
select dblink_disconnect('link-idem-2');

do $$ begin
  assert (select count(*) from public.external_vpn_devices where link_id='10000000-0000-4000-8000-000000000002')=1,
    'concurrent identical retries allocated multiple clients';
  assert (select count(*) from public.devices where subscription_id=900000010 and status='ACTIVE')=2,
    'Link races consumed an unexpected number of canonical seats';
end $$;

-- Two different keys contend for the subscription's final (third) seat.
insert into public.vpn_links(id,account_id,name,desired_route_id,max_clients)
select '10000000-0000-4000-8000-000000000003',account_id,'Account final seat','route_link_race',2
from public.account_members where user_id='11111111-1111-1111-1111-111111111111';
select dblink_connect('link-seat-1','dbname='||current_database());
select dblink_connect('link-seat-2','dbname='||current_database());
select dblink_send_query('link-seat-1',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000003',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Seat A','singbox',repeat('8',64),
    'ext_'||repeat('e',43),repeat('8',64),'cred_'||repeat('e',43),'cipher-e','nonce-e',now()+interval '7 days')
$q$);
select dblink_send_query('link-seat-2',$q$
  select public.create_vpn_link_client('10000000-0000-4000-8000-000000000003',
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000010,'Seat B','singbox',repeat('9',64),
    'ext_'||repeat('f',43),repeat('9',64),'cred_'||repeat('f',43),'cipher-f','nonce-f',now()+interval '7 days')
$q$);
select * from dblink_get_result('link-seat-1',false) as t(device_id uuid);
select * from dblink_get_result('link-seat-2',false) as t(device_id uuid);
select dblink_disconnect('link-seat-1');
select dblink_disconnect('link-seat-2');

do $$ begin
  assert (select count(*) from public.external_vpn_devices where link_id='10000000-0000-4000-8000-000000000003')=1,
    'concurrent Link calls exceeded subscription entitlement';
  assert (select count(*) from public.devices where subscription_id=900000010 and status='ACTIVE')=3,
    'subscription final-seat race did not settle at canonical capacity';
end $$;
