-- Real two-session final-seat race. Each dblink connection runs in its own
-- transaction; the subscription advisory lock must serialize both contenders.
create extension if not exists dblink;

insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('concurrency-node',repeat('9',64),'00000000-0000-4000-8000-000000000000','READY','mock','concurrency.example.test');
insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_concurrency_fast','race','fast','Concurrency — Fast');
insert into public.logical_route_targets(route_id,hop,node_id)
values ('route_concurrency_fast',1,'concurrency-node');

insert into public.subscriptions(id,account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
overriding system value
select 900000001,account_id,'sub_concurrency','active','Concurrency',0,now()+interval '30 days'
from public.account_members where user_id='11111111-1111-1111-1111-111111111111';

select public.create_external_vpn_device(
  (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
  '11111111-1111-1111-1111-111111111111',900000001,'Existing 1','hiddify',
  'ext_'||repeat('a',43),repeat('1',64),'route_concurrency_fast','cred_'||repeat('a',43),'cipher','nonce',now()+interval '7 days');
select public.create_external_vpn_device(
  (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
  '11111111-1111-1111-1111-111111111111',900000001,'Existing 2','hiddify',
  'ext_'||repeat('b',43),repeat('2',64),'route_concurrency_fast','cred_'||repeat('b',43),'cipher','nonce',now()+interval '7 days');

select dblink_connect('seat-c1','dbname='||current_database());
select dblink_connect('seat-c2','dbname='||current_database());
select dblink_send_query('seat-c1',$q$
  select public.create_external_vpn_device(
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000001,'Contender A','hiddify',
    'ext_ccccccccccccccccccccccccccccccccccccccccccc',repeat('3',64),'route_concurrency_fast',
    'cred_ccccccccccccccccccccccccccccccccccccccccccc','cipher','nonce',now()+interval '7 days')
$q$);
select dblink_send_query('seat-c2',$q$
  select public.create_external_vpn_device(
    (select account_id from public.account_members where user_id='11111111-1111-1111-1111-111111111111'),
    '11111111-1111-1111-1111-111111111111',900000001,'Contender B','hiddify',
    'ext_ddddddddddddddddddddddddddddddddddddddddddd',repeat('4',64),'route_concurrency_fast',
    'cred_ddddddddddddddddddddddddddddddddddddddddddd','cipher','nonce',now()+interval '7 days')
$q$);

-- fail_on_error=false lets us inspect the invariant after the expected loser.
select * from dblink_get_result('seat-c1',false) as t(device_id uuid);
select * from dblink_get_result('seat-c2',false) as t(device_id uuid);
select dblink_disconnect('seat-c1');
select dblink_disconnect('seat-c2');

do $$ begin
  assert (select count(*) from public.devices where subscription_id=900000001 and status='ACTIVE')=3,
    'concurrent final-seat allocation exceeded three seats';
  assert (select count(*) from public.external_vpn_devices e join public.devices d on d.id=e.device_id
    where d.subscription_id=900000001)=3,
    'losing contender left an orphan external device';
end $$;
