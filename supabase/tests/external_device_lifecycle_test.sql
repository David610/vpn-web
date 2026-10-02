-- Transactional Phase-2 seat, revocation, A/B, rollback and acknowledgement tests.
begin;

insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_test_fast','test','fast','Test — Fast'),
       ('route_test_empty','empty','fast','Unavailable — Fast');
insert into public.logical_route_targets(route_id,hop,node_id,priority)
values ('route_test_fast',1,'node-1',100);

do $$
declare
  v_user uuid := '11111111-1111-1111-1111-111111111111';
  v_account uuid := (select account_id from public.account_members where user_id=v_user);
  v_sub bigint; v_device uuid; v_rejected boolean; v_count integer;
  cap integer; extra integer; i integer;
  prefix text;
begin
  -- The database RPC serializes contenders on the subscription advisory lock.
  -- Verify each supported business tier reaches, but can never exceed, capacity.
  foreach cap in array array[3,6,9] loop
    extra := cap - 3;
    insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
      values(v_account,'sub_cap_'||cap,'active','Capacity '||cap,extra,now()+interval '30 days') returning id into v_sub;
    for i in 1..cap loop
      prefix := lpad((cap*10+i)::text,43,'a');
      perform public.create_external_vpn_device(v_account,v_user,v_sub,'Device '||i,'hiddify',
        'ext_'||prefix,encode(extensions.gen_random_bytes(32),'hex'),'route_test_fast',
        'cred_'||prefix,'cipher','nonce',now()+interval '7 days');
    end loop;
    begin
      prefix := lpad((cap*10+cap+1)::text,43,'b');
      perform public.create_external_vpn_device(v_account,v_user,v_sub,'Over capacity','hiddify',
        'ext_'||prefix,encode(extensions.gen_random_bytes(32),'hex'),'route_test_fast',
        'cred_'||prefix,'cipher','nonce',now()+interval '7 days');
      raise exception 'capacity % exceeded',cap;
    exception when others then
      if sqlerrm <> 'seats_full' then raise; end if;
    end;
    select count(*) into v_count from public.devices where subscription_id=v_sub and status='ACTIVE';
    assert v_count=cap, 'capacity changed after rejected final-seat contender';
  end loop;

  -- Revocation releases one seat once, leaves credentials revoked, and burns token.
  select d.device_id into v_device from public.external_vpn_devices d
    join public.devices b on b.id=d.device_id where b.subscription_id=v_sub limit 1;
  assert public.revoke_external_vpn_device(v_device,v_account);
  assert not public.revoke_external_vpn_device(v_device,v_account);
  assert (select count(*) from public.compatibility_credentials where device_id=v_device and revoked_at is not null)=1;
  assert not exists(select 1 from public.devices where id=v_device and subscription_id is not null);

  -- A+B may overlap; C is rejected until A is exactly at its end boundary.
  select d.device_id into v_device from public.external_vpn_devices d
    join public.devices b on b.id=d.device_id where b.subscription_id=v_sub and b.status='ACTIVE' limit 1;
  prefix := lpad('rotationb',43,'c');
  assert public.rotate_compatibility_credential(v_device,v_account,'cred_'||prefix,'cipher-b','nonce-b',now()+interval '7 days',3600);
  begin
    prefix := lpad('rotationc',43,'d');
    insert into public.compatibility_credentials(device_id,credential_id,credential_ciphertext,credential_nonce,valid_from,valid_until,publish_from)
      values(v_device,'cred_'||prefix,'cipher-c','nonce-c',now(),now()+interval '7 days',now());
    raise exception 'third live generation accepted';
  exception when others then
    if sqlerrm <> 'compatibility_credential_limit' then raise; end if;
  end;
  update public.compatibility_credentials set valid_until=now()
    where device_id=v_device and credential_ciphertext<>'cipher-b';
  prefix := lpad('rotationc',43,'d');
  insert into public.compatibility_credentials(device_id,credential_id,credential_ciphertext,credential_nonce,valid_from,valid_until,publish_from)
    values(v_device,'cred_'||prefix,'cipher-c','nonce-c',now(),now()+interval '7 days',now());

  -- Missing route projection aborts every write in create_external_vpn_device.
  select count(*) into v_count from public.external_vpn_devices;
  begin
    prefix := lpad('rollback',43,'e');
    perform public.create_external_vpn_device(v_account,v_user,v_sub,'Rollback','hiddify',
      'ext_'||prefix,encode(extensions.gen_random_bytes(32),'hex'),'route_test_empty',
      'cred_'||prefix,'cipher','nonce',now()+interval '7 days');
    raise exception 'unavailable route accepted';
  exception when others then
    if sqlerrm <> 'route_unavailable' then raise; end if;
  end;
  assert (select count(*) from public.external_vpn_devices)=v_count;

  -- Pending is fail-closed; only the authenticated-node RPC transition marks
  -- the exact credential revision applied.
  select count(*) into v_count from public.compatibility_authorization_deployments where state='pending';
  assert v_count>0;
  perform public.ack_compatibility_authorizations('node-1',array[(select credential_id from public.compatibility_authorizations where node_id='node-1' and not revoked limit 1)]);
  assert exists(select 1 from public.compatibility_authorization_deployments where state='applied' and applied_revision=desired_revision);
end $$;
rollback;
