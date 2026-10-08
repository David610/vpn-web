-- 20261017000000: encrypted access-link storage and Link location mode.
-- The migration must be additive (existing rows keep working), the ciphertext
-- and nonce must travel together, and no API role may read either column.
begin;

insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('access-node',repeat('7',64),'00000000-0000-4000-8000-000000000000','READY','mock','access-node.example.test');
insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_access_fast','access','fast','Access test');
insert into public.logical_route_targets(route_id,hop,node_id) values ('route_access_fast',1,'access-node');

do $$
declare
  v_user uuid := '11111111-1111-1111-1111-111111111111';
  v_account uuid := (select account_id from public.account_members where user_id=v_user);
  v_sub bigint; v_link uuid; v_device uuid;
begin
  insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
    values(v_account,'sub_access','active','Access',0,now()+interval '30 days') returning id into v_sub;

  -- A Link created the old way keeps working and defaults to a manual location.
  v_link := public.create_vpn_link(v_account,'Phone','route_access_fast',1);
  assert (select location_mode from public.vpn_links where id=v_link)='manual',
    'a new Link did not default to a manual location';

  update public.vpn_links set location_mode='auto' where id=v_link;
  assert (select location_mode from public.vpn_links where id=v_link)='auto', 'auto location mode was not stored';
  begin
    update public.vpn_links set location_mode='fastest' where id=v_link;
    raise exception 'an unknown location mode was accepted';
  exception when check_violation then null;
  end;

  v_device := public.create_vpn_link_client(v_link,v_account,v_user,v_sub,'Phone','links',repeat('a',64),
    'ext_'||repeat('a',43),repeat('b',64),'cred_'||repeat('a',43),'cipher-a','nonce-a',now()+interval '7 days');

  -- A client created without sealed access-link storage (every row that
  -- existed before this migration) has NULLs in both columns.
  assert (select subscription_token_ciphertext is null and subscription_token_nonce is null
          from public.external_vpn_devices where device_id=v_device),
    'a client created without sealed storage did not have NULL ciphertext and nonce';

  update public.external_vpn_devices
     set subscription_token_ciphertext='\x00ff', subscription_token_nonce='\x01'
   where device_id=v_device;
  assert (select subscription_token_ciphertext from public.external_vpn_devices where device_id=v_device)='\x00ff',
    'sealed access link was not stored';

  -- Ciphertext and nonce are a pair: one without the other is unusable.
  begin
    update public.external_vpn_devices set subscription_token_nonce=null where device_id=v_device;
    raise exception 'ciphertext without a nonce was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.external_vpn_devices
       set subscription_token_ciphertext=null where device_id=v_device;
    raise exception 'a nonce without ciphertext was accepted';
  exception when check_violation then null;
  end;

  -- Rotation clears both together.
  update public.external_vpn_devices
     set subscription_token_ciphertext=null, subscription_token_nonce=null
   where device_id=v_device;
  assert (select subscription_token_ciphertext is null from public.external_vpn_devices where device_id=v_device),
    'clearing the pair failed';

  -- No API role can read the sealed token or the table that holds it.
  assert not has_table_privilege('anon','public.external_vpn_devices','select'),
    'anon may read external VPN devices';
  assert not has_table_privilege('authenticated','public.external_vpn_devices','select'),
    'authenticated may read external VPN devices';
  assert not has_column_privilege('authenticated','public.external_vpn_devices','subscription_token_ciphertext','select'),
    'authenticated may read the sealed access link';
  assert not has_column_privilege('anon','public.external_vpn_devices','subscription_token_ciphertext','select'),
    'anon may read the sealed access link';
  assert not has_column_privilege('authenticated','public.vpn_links','location_mode','update'),
    'authenticated may change a Link location mode directly';
end $$;

rollback;
