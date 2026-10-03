-- Link/container, independent client credentials, capacity, idempotency,
-- cascading revocation, ownership and privacy invariants.
begin;

insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('link-node',repeat('8',64),'00000000-0000-4000-8000-000000000000','READY','mock','link-node.example.test');
insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_links_fast','links','fast','Links test');
insert into public.logical_route_targets(route_id,hop,node_id) values ('route_links_fast',1,'link-node');

do $$
declare
  v_user uuid := '11111111-1111-1111-1111-111111111111';
  v_account uuid := (select account_id from public.account_members where user_id=v_user);
  v_other_account uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_sub bigint; v_link uuid; v_device_a uuid; v_device_b uuid; v_replay uuid;
  v_credential_a text; v_credential_b text;
begin
  insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
    values(v_account,'sub_links','active','Links',0,now()+interval '30 days') returning id into v_sub;

  v_link := public.create_vpn_link(v_account,'Office routers','route_links_fast',2);
  assert (select count(*) from public.devices where subscription_id=v_sub)=0,
    'a Link container consumed capacity';

  v_device_a := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Router A','singbox',repeat('1',64),
    'ext_'||repeat('a',43),repeat('2',64),'cred_'||repeat('a',43),'cipher-a','nonce-a',now()+interval '7 days');
  v_replay := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'ignored retry','singbox',repeat('1',64),
    'ext_'||repeat('z',43),repeat('3',64),'cred_'||repeat('z',43),'never-written','never-written',now()+interval '7 days');
  assert v_replay=v_device_a, 'idempotent retry did not return the original client';
  assert (select count(*) from public.devices where subscription_id=v_sub)=1,
    'idempotent retry consumed another capacity unit';

  v_device_b := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Router B','singbox',repeat('4',64),
    'ext_'||repeat('b',43),repeat('5',64),'cred_'||repeat('b',43),'cipher-b','nonce-b',now()+interval '7 days');
  select credential_id into v_credential_a from public.compatibility_credentials where device_id=v_device_a;
  select credential_id into v_credential_b from public.compatibility_credentials where device_id=v_device_b;
  assert v_credential_a<>v_credential_b, 'clients shared a credential identity';

  begin
    perform public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Too many','singbox',repeat('6',64),
      'ext_'||repeat('c',43),repeat('7',64),'cred_'||repeat('c',43),'cipher-c','nonce-c',now()+interval '7 days');
    raise exception 'link capacity exceeded';
  exception when others then
    if sqlerrm <> 'link_capacity_full' then raise; end if;
  end;

  assert public.revoke_external_vpn_device(v_device_a,v_account);
  assert (select revoked_at is not null from public.compatibility_credentials where credential_id=v_credential_a);
  assert (select revoked_at is null from public.compatibility_credentials where credential_id=v_credential_b),
    'revoking client A revoked client B';

  -- A revoked client releases both its canonical device seat and its Link slot.
  v_device_a := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Router C','singbox',repeat('8',64),
    'ext_'||repeat('c',43),repeat('9',64),'cred_'||repeat('c',43),'cipher-c','nonce-c',now()+interval '7 days');
  assert public.revoke_vpn_link(v_link,v_account);
  assert not exists(select 1 from public.external_vpn_devices where link_id=v_link and revoked_at is null),
    'Link revoke left an active client';
  assert not exists(select 1 from public.compatibility_authorizations a
    join public.external_vpn_devices e on e.principal_id=a.principal_id
    where e.link_id=v_link and not a.revoked), 'Link revoke left node authorization active';

  insert into public.customer_accounts(id,name) values(v_other_account,'Other account');
  assert not public.revoke_vpn_link(v_link,v_other_account), 'cross-account Link mutation succeeded';

  -- The aggregate schema is intentionally incapable of accepting browsing telemetry.
  assert not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='vpn_link_usage_daily'
    and column_name in ('url','domain','dns_query','destination_ip','payload','search_query'));
end $$;

do $$ begin
  assert not has_table_privilege('authenticated','public.vpn_links','select'),
    'authenticated may bypass the account API to read Links';
  assert not has_table_privilege('authenticated','public.vpn_link_usage_daily','select'),
    'authenticated may bypass the account API to read usage';
  assert not has_function_privilege('authenticated','public.create_vpn_link(uuid,text,text,integer)','execute'),
    'authenticated may invoke Link creation directly';
  assert not has_function_privilege('authenticated',
    'public.create_vpn_link_client(uuid,uuid,uuid,bigint,text,text,text,text,text,text,text,text,timestamptz)','execute'),
    'authenticated may invoke client creation directly';
end $$;

rollback;
