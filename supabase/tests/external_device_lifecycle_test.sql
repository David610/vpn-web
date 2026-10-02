-- Transactional Phase-2 seat, revocation, A/B, rollback and acknowledgement tests.
begin;

-- seed.sql intentionally does not create a fleet node. This fixture owns the
-- physical nodes referenced by its logical targets; keep the production FK.
insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('node-1',repeat('1',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-1.example.test'),
       ('node-2',repeat('2',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-2.example.test');

insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_test_fast','test','fast','Test — Fast'),
       ('route_test_empty','empty','fast','Unavailable — Fast');
insert into public.logical_route_targets(route_id,hop,node_id,priority)
values ('route_test_fast',1,'node-1',100);

do $$
declare
  v_user uuid := '11111111-1111-1111-1111-111111111111';
  v_account uuid := (select account_id from public.account_members where user_id=v_user);
  v_sub bigint; v_device uuid; v_count integer; v_revision bigint; v_next_revision bigint; v_old_token text;
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
  select subscription_token_hash into v_old_token from public.external_vpn_devices where device_id=v_device;
  assert public.revoke_external_vpn_device(v_device,v_account);
  assert not public.revoke_external_vpn_device(v_device,v_account);
  assert (select count(*) from public.compatibility_credentials where device_id=v_device and revoked_at is not null)=1;
  assert not exists(select 1 from public.devices where id=v_device and subscription_id is not null);
  assert (select subscription_token_hash<>v_old_token from public.external_vpn_devices where device_id=v_device);

  -- A+B may overlap; C is rejected until A is exactly at its end boundary.
  select d.device_id into v_device from public.external_vpn_devices d
    join public.devices b on b.id=d.device_id where b.subscription_id=v_sub and b.status='ACTIVE' limit 1;
  -- Rotation is equally atomic when the desired route has no physical target.
  update public.external_vpn_devices set desired_route_id='route_test_empty' where device_id=v_device;
  select count(*) into v_count from public.compatibility_credentials where device_id=v_device;
  begin
    prefix := lpad('badrotation',43,'f');
    perform public.rotate_compatibility_credential(v_device,v_account,'cred_'||prefix,
      'bad-cipher','bad-nonce',now()+interval '7 days',3600);
    raise exception 'rotation onto unavailable route accepted';
  exception when others then
    if sqlerrm <> 'route_unavailable' then raise; end if;
  end;
  assert (select count(*) from public.compatibility_credentials where device_id=v_device)=v_count;
  assert not exists(select 1 from public.compatibility_authorizations where credential_id='cred_'||prefix);
  update public.external_vpn_devices set desired_route_id='route_test_fast' where device_id=v_device;

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
  update public.compatibility_credentials set valid_from=now()-interval '1 second',valid_until=now()
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

  -- Exact snapshot ACK: mutation after fetch must not allow stale revision N
  -- to acknowledge desired revision N+1.
  select desired_revision into v_revision from public.compatibility_authorization_node_state where node_id='node-1';
  perform public.ack_compatibility_authorization_snapshot('node-1',v_revision);
  update public.compatibility_authorizations set credential_nonce=credential_nonce||'-changed'
    where node_id='node-1' and credential_id=(select credential_id from public.compatibility_authorizations where node_id='node-1' limit 1);
  select desired_revision into v_next_revision from public.compatibility_authorization_node_state where node_id='node-1';
  assert v_next_revision=v_revision+1;
  perform public.ack_compatibility_authorization_snapshot('node-1',v_revision);
  assert (select applied_revision from public.compatibility_authorization_node_state where node_id='node-1')=v_revision;
  assert (select state from public.compatibility_authorization_node_state where node_id='node-1')='pending';
  begin
    perform public.ack_compatibility_authorization_snapshot('node-1',v_next_revision+1);
    raise exception 'future snapshot ACK accepted';
  exception when others then
    if sqlerrm <> 'future_snapshot_revision' then raise; end if;
  end;

  -- Make before break: healthy node-2 is not publishable merely because a
  -- projection exists. Node-1 remains proven until node-2 ACKs its snapshot.
  insert into public.logical_route_targets(route_id,hop,node_id,priority) values('route_test_fast',1,'node-2',10);
  insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,logical_route_id,node_id,
    valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
  select principal_id,credential_id,credential_class,logical_route_id,'node-2',valid_from,valid_until,revoked,
    credential_ciphertext,credential_nonce from public.compatibility_authorizations
    where node_id='node-1' and not revoked and valid_until>now() limit 1;
  assert not exists(select 1 from public.get_publishable_compatibility_deployments(
    array[(select credential_id from public.compatibility_authorizations where node_id='node-2' limit 1)]) where node_id='node-2');
  select desired_revision into v_revision from public.compatibility_authorization_node_state where node_id='node-2';
  perform public.ack_compatibility_authorization_snapshot('node-2',v_revision);
  assert exists(select 1 from public.get_publishable_compatibility_deployments(
    array[(select credential_id from public.compatibility_authorizations where node_id='node-2' limit 1)]) where node_id='node-2');

  -- Empty snapshots are first-class and ACKable proof of removal.
  delete from public.compatibility_authorizations where node_id='node-2';
  select snapshot_revision,(jsonb_array_length(authorizations)) into v_revision,v_count
    from public.get_compatibility_authorization_snapshot('node-2');
  assert v_count=0;
  perform public.ack_compatibility_authorization_snapshot('node-2',v_revision);
  assert (select applied_revision=desired_revision from public.compatibility_authorization_node_state where node_id='node-2');
end $$;
rollback;
