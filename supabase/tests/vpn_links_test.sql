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
  v_sub bigint; v_other_sub bigint; v_link uuid; v_empty_link uuid; v_device_a uuid; v_device_b uuid; v_unrelated uuid; v_replay uuid;
  v_credential_a text; v_credential_b text; v_credential_row_a uuid; v_revision_before bigint;
begin
  insert into public.customer_accounts(id) values(v_other_account);
  insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
    values(v_account,'sub_links','active','Links',0,now()+interval '30 days') returning id into v_sub;
  insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
    values(v_other_account,'sub_links_other','active','Other Links',0,now()+interval '30 days') returning id into v_other_sub;

  v_link := public.create_vpn_link(v_account,'Office routers','route_links_fast',2);
  assert (select count(*) from public.devices where subscription_id=v_sub)=0,
    'a Link container consumed capacity';

  begin
    perform public.create_vpn_link_client(v_link,v_other_account,v_user,v_sub,'Cross account','singbox',repeat('f',64),
      'ext_'||repeat('f',43),repeat('f',64),'cred_'||repeat('f',43),'cipher-f','nonce-f',now()+interval '7 days');
    raise exception 'cross-account client creation accepted';
  exception when others then
    if sqlerrm <> 'link_not_active' then raise; end if;
  end;
  begin
    perform public.create_vpn_link_client(v_link,v_account,'22222222-2222-2222-2222-222222222222',v_sub,
      'Non-member','singbox',repeat('e',64),'ext_'||repeat('e',43),repeat('e',64),
      'cred_'||repeat('e',43),'cipher-e','nonce-e',now()+interval '7 days');
    raise exception 'non-member client creation accepted';
  exception when others then
    if sqlerrm <> 'user_not_in_account' then raise; end if;
  end;

  -- A foreign subscription cannot be charged even when every other input is owned.
  begin
    perform public.create_vpn_link_client(v_link,v_account,v_user,v_other_sub,'Foreign seat','singbox',repeat('0',64),
      'ext_'||repeat('q',43),repeat('0',64),'cred_'||repeat('q',43),'cipher-q','nonce-q',now()+interval '7 days');
    raise exception 'foreign subscription accepted';
  exception when others then
    if sqlerrm <> 'subscription_not_entitled' then raise; end if;
  end;

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
  select id into v_credential_row_a from public.compatibility_credentials where device_id=v_device_a;
  assert public.rotate_compatibility_credential(v_device_a,v_account,
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||repeat('r',43),
      'credential_ciphertext','cipher-rotated','credential_nonce','nonce-rotated')),
    now()+interval '7 days',3600);
  assert (select generation=2 and rotated_from=v_credential_row_a from public.compatibility_credentials
    where device_id=v_device_a and credential_id='cred_'||repeat('r',43)),
    'rotation generation or lineage is incorrect';

  begin
    perform public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Too many','singbox',repeat('6',64),
      'ext_'||repeat('c',43),repeat('7',64),'cred_'||repeat('c',43),'cipher-c','nonce-c',now()+interval '7 days');
    raise exception 'link capacity exceeded';
  exception when others then
    if sqlerrm <> 'link_capacity_full' then raise; end if;
  end;

  assert public.revoke_external_vpn_device(v_device_a,v_account);
  assert (select bool_and(revoked_at is not null) from public.compatibility_credentials where device_id=v_device_a);
  assert (select revoked_at is null from public.compatibility_credentials where credential_id=v_credential_b),
    'revoking client A revoked client B';

  -- A revoked client releases both its canonical device seat and its Link slot.
  v_device_a := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Router C','singbox',repeat('8',64),
    'ext_'||repeat('c',43),repeat('9',64),'cred_'||repeat('c',43),'cipher-c','nonce-c',now()+interval '7 days');
  v_unrelated := public.create_external_vpn_device(v_account,v_user,v_sub,'Unrelated','singbox',
    'ext_'||repeat('u',43),repeat('a',64),'route_links_fast',
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||repeat('u',43),
      'credential_ciphertext','cipher-u','credential_nonce','nonce-u')),
    now()+interval '7 days');
  select desired_revision into v_revision_before
    from public.compatibility_authorization_node_state where node_id='link-node';
  assert public.revoke_vpn_link(v_link,v_account);
  assert not exists(select 1 from public.external_vpn_devices where link_id=v_link and revoked_at is null),
    'Link revoke left an active client';
  assert not exists(select 1 from public.compatibility_authorizations a
    join public.external_vpn_devices e on e.principal_id=a.principal_id
    where e.link_id=v_link and not a.revoked), 'Link revoke left node authorization active';
  assert (select revoked_at is null from public.external_vpn_devices where device_id=v_unrelated),
    'Link revoke affected an unrelated external client';
  assert (select desired_revision > v_revision_before
    from public.compatibility_authorization_node_state where node_id='link-node'),
    'Link revoke did not advance the node authorization snapshot';
  assert not public.revoke_vpn_link(v_link,v_account), 'Link revoke was not idempotent';

  assert not public.revoke_vpn_link(v_link,v_other_account), 'cross-account Link mutation succeeded';

  v_empty_link := public.create_vpn_link(v_account,'Empty Link','route_links_fast',1);
  begin
    insert into public.vpn_link_usage_daily(account_id,link_id,device_id,bucket_date,rx_bytes,tx_bytes)
      values(v_account,v_empty_link,v_unrelated,current_date,1,2);
    raise exception 'cross-Link usage attribution accepted';
  exception when foreign_key_violation then null;
  end;
  assert public.revoke_vpn_link(v_empty_link,v_account), 'zero-client Link revoke failed';

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
