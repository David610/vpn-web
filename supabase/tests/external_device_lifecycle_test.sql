-- Transactional Phase-2 seat, revocation, A/B, rollback and acknowledgement tests.
begin;

-- seed.sql intentionally does not create a fleet node. This fixture owns the
-- physical nodes referenced by its logical targets; keep the production FK.
insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('node-1',repeat('1',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-1.example.test'),
       ('node-2',repeat('2',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-2.example.test'),
       ('node-3',repeat('3',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-3.example.test'),
       -- Dedicated to the privacy_plus scenario below, kept separate from
       -- node-2/node-3's later make-before-break/ACK assertions so minting
       -- a second device's worth of authorizations here can never change
       -- those nodes' revision counts or snapshot contents.
       ('node-entry',repeat('4',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-entry.example.test'),
       ('node-exit',repeat('5',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-exit.example.test');

insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_test_fast','test','fast','Test — Fast'),
       ('route_test_empty','empty','fast','Unavailable — Fast'),
       ('route_test_privacy_plus','privacy','privacy_plus','Test — Privacy+');
insert into public.logical_route_targets(route_id,hop,node_id,priority)
values ('route_test_fast',1,'node-1',100),
       ('route_test_privacy_plus',1,'node-entry',100),
       ('route_test_privacy_plus',2,'node-exit',100);

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
        jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||prefix,
          'credential_ciphertext','cipher','credential_nonce','nonce')),
        now()+interval '7 days');
    end loop;
    begin
      prefix := lpad((cap*10+cap+1)::text,43,'b');
      perform public.create_external_vpn_device(v_account,v_user,v_sub,'Over capacity','hiddify',
        'ext_'||prefix,encode(extensions.gen_random_bytes(32),'hex'),'route_test_fast',
        jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||prefix,
          'credential_ciphertext','cipher','credential_nonce','nonce')),
        now()+interval '7 days');
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
    perform public.rotate_compatibility_credential(v_device,v_account,
      jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||prefix,
        'credential_ciphertext','bad-cipher','credential_nonce','bad-nonce')),
      now()+interval '7 days',3600);
    raise exception 'rotation onto unavailable route accepted';
  exception when others then
    if sqlerrm <> 'route_unavailable' then raise; end if;
  end;
  assert (select count(*) from public.compatibility_credentials where device_id=v_device)=v_count;
  assert not exists(select 1 from public.compatibility_authorizations where credential_id='cred_'||prefix);
  update public.external_vpn_devices set desired_route_id='route_test_fast' where device_id=v_device;

  prefix := lpad('rotationb',43,'c');
  assert public.rotate_compatibility_credential(v_device,v_account,
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||prefix,
      'credential_ciphertext','cipher-b','credential_nonce','nonce-b')),
    now()+interval '7 days',3600);
  begin
    prefix := lpad('rotationc',43,'d');
    insert into public.compatibility_credentials(device_id,credential_id,credential_ciphertext,credential_nonce,valid_from,valid_until,publish_from)
      values(v_device,'cred_'||prefix,'cipher-c','nonce-c',now(),now()+interval '7 days',now());
    raise exception 'third live generation accepted';
  exception when others then
    if sqlerrm <> 'compatibility_credential_limit' then raise; end if;
  end;
  update public.compatibility_credentials set
    valid_from=now()-interval '3 seconds',publish_from=now()-interval '2 seconds',valid_until=now()-interval '1 second'
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
      jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||prefix,
        'credential_ciphertext','cipher','credential_nonce','nonce')),
      now()+interval '7 days');
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

  -- Revision zero is the explicit initial empty snapshot. ACK 0 transitions
  -- pending -> applied and is idempotent. The first projected credential then
  -- becomes revision 1 and remains non-publishable until exact ACK 1.
  select snapshot_revision,jsonb_array_length(authorizations) into v_revision,v_count
    from public.get_compatibility_authorization_snapshot('node-3');
  assert v_revision=0 and v_count=0;
  perform public.ack_compatibility_authorization_snapshot('node-3',0);
  assert (select state='applied' and desired_revision=0 and applied_revision=0
    from public.compatibility_authorization_node_state where node_id='node-3');
  perform public.ack_compatibility_authorization_snapshot('node-3',0);
  assert (select state='applied' from public.compatibility_authorization_node_state where node_id='node-3');
  insert into public.compatibility_authorizations(principal_id,credential_id,credential_class,logical_route_id,node_id,
    valid_from,valid_until,revoked,credential_ciphertext,credential_nonce)
  select principal_id,credential_id,credential_class,logical_route_id,'node-3',valid_from,valid_until,revoked,
    credential_ciphertext,credential_nonce from public.compatibility_authorizations
    where node_id='node-1' and not revoked and valid_until>now() limit 1;
  assert (select desired_revision=1 and applied_revision=0 and state='pending'
    from public.compatibility_authorization_node_state where node_id='node-3');
  perform public.ack_compatibility_authorization_snapshot('node-3',0);
  assert (select state='pending' and applied_revision=0
    from public.compatibility_authorization_node_state where node_id='node-3');
  assert not exists(select 1 from public.get_publishable_compatibility_deployments(
    array[(select credential_id from public.compatibility_authorizations where node_id='node-3')]) where node_id='node-3');
  perform public.ack_compatibility_authorization_snapshot('node-3',1);
  assert (select state='applied' and applied_revision=1
    from public.compatibility_authorization_node_state where node_id='node-3');
  assert exists(select 1 from public.get_publishable_compatibility_deployments(
    array[(select credential_id from public.compatibility_authorizations where node_id='node-3')]) where node_id='node-3');

  -- Privacy+ (two-hop): each hop gets its OWN credential, authorized only
  -- on its own hop's node -- never the same credential on both, which is
  -- what this whole migration exists to fix.
  declare
    v_pp_sub bigint; v_pp_device uuid; v_entry_cred text; v_exit_cred text;
    v_entry_cred_row uuid; v_exit_cred_row uuid;
  begin
    insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
      values(v_account,'sub_pp','active','Privacy+ test',0,now()+interval '30 days') returning id into v_pp_sub;
    v_entry_cred := 'cred_'||lpad('ppentry',43,'g');
    v_exit_cred := 'cred_'||lpad('ppexit',43,'h');
    v_pp_device := public.create_external_vpn_device(v_account,v_user,v_pp_sub,'Privacy+ device','singbox',
      'ext_'||lpad('pp',43,'i'),encode(extensions.gen_random_bytes(32),'hex'),'route_test_privacy_plus',
      jsonb_build_array(
        jsonb_build_object('hop',1,'credential_id',v_entry_cred,'credential_ciphertext','entry-cipher','credential_nonce','entry-nonce'),
        jsonb_build_object('hop',2,'credential_id',v_exit_cred,'credential_ciphertext','exit-cipher','credential_nonce','exit-nonce')
      ), now()+interval '7 days');

    assert (select count(*) from public.compatibility_credentials where device_id=v_pp_device)=2,
      'privacy_plus device must have exactly one credential per hop';
    assert (select hop from public.compatibility_credentials where device_id=v_pp_device and credential_id=v_entry_cred)=1;
    assert (select hop from public.compatibility_credentials where device_id=v_pp_device and credential_id=v_exit_cred)=2;

    -- Each hop starts its own generation/lineage at 1 with no prior --
    -- hop 2 must NOT look like a rotation of hop 1 just because it was
    -- inserted immediately after it for the same device.
    assert (select generation from public.compatibility_credentials where credential_id=v_entry_cred)=1;
    assert (select generation from public.compatibility_credentials where credential_id=v_exit_cred)=1;
    assert (select rotated_from is null from public.compatibility_credentials where credential_id=v_entry_cred);
    assert (select rotated_from is null from public.compatibility_credentials where credential_id=v_exit_cred);
    select id into v_entry_cred_row from public.compatibility_credentials where credential_id=v_entry_cred;
    select id into v_exit_cred_row from public.compatibility_credentials where credential_id=v_exit_cred;

    -- The entry credential is authorized on node-entry and NOWHERE else;
    -- the exit credential is authorized on node-exit and nowhere else.
    -- This is the exact bug this migration fixes: before it, one
    -- credential was projected onto every target row regardless of hop.
    assert (select array_agg(node_id) from public.compatibility_authorizations where credential_id=v_entry_cred)=array['node-entry'];
    assert (select array_agg(node_id) from public.compatibility_authorizations where credential_id=v_exit_cred)=array['node-exit'];
    assert not exists(select 1 from public.compatibility_authorizations where credential_id=v_entry_cred and node_id='node-exit');
    assert not exists(select 1 from public.compatibility_authorizations where credential_id=v_exit_cred and node_id='node-entry');

    -- A privacy_plus device legitimately holds two SIMULTANEOUS live
    -- credentials (one per hop) -- the per-hop limit trigger must not
    -- confuse that with the old per-device "at most two generations"
    -- rotation limit and reject it.
    assert (select count(*) from public.compatibility_credentials
      where device_id=v_pp_device and revoked_at is null and valid_until>now())=2;

    -- Supplying the wrong set of hops -- one credential for a two-hop
    -- route, or vice versa -- aborts the whole call rather than creating a
    -- partially-credentialed device.
    begin
      perform public.create_external_vpn_device(v_account,v_user,v_pp_sub,'Bad hop count','singbox',
        'ext_'||lpad('ppbad',43,'j'),encode(extensions.gen_random_bytes(32),'hex'),'route_test_privacy_plus',
        jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||lpad('ppbad',43,'k'),
          'credential_ciphertext','c','credential_nonce','n')),
        now()+interval '7 days');
      raise exception 'one-credential privacy_plus device accepted';
    exception when others then
      if sqlerrm <> 'credential_hop_mismatch' then raise; end if;
    end;
    begin
      perform public.create_external_vpn_device(v_account,v_user,v_pp_sub,'Bad hop count 2','hiddify',
        'ext_'||lpad('ppbad2',43,'l'),encode(extensions.gen_random_bytes(32),'hex'),'route_test_fast',
        jsonb_build_array(
          jsonb_build_object('hop',1,'credential_id','cred_'||lpad('ppbad2a',43,'m'),'credential_ciphertext','c','credential_nonce','n'),
          jsonb_build_object('hop',2,'credential_id','cred_'||lpad('ppbad2b',43,'o'),'credential_ciphertext','c','credential_nonce','n')
        ), now()+interval '7 days');
      raise exception 'two-credential fast device accepted';
    exception when others then
      if sqlerrm <> 'credential_hop_mismatch' then raise; end if;
    end;

    -- Rotation replaces both hops together, each still authorized only
    -- against its own node.
    declare v_entry_cred2 text := 'cred_'||lpad('ppentry2',43,'p'); v_exit_cred2 text := 'cred_'||lpad('ppexit2',43,'q');
    begin
      assert public.rotate_compatibility_credential(v_pp_device,v_account,
        jsonb_build_array(
          jsonb_build_object('hop',1,'credential_id',v_entry_cred2,'credential_ciphertext','entry-cipher-2','credential_nonce','entry-nonce-2'),
          jsonb_build_object('hop',2,'credential_id',v_exit_cred2,'credential_ciphertext','exit-cipher-2','credential_nonce','exit-nonce-2')
        ), now()+interval '7 days',3600);
      assert (select array_agg(node_id) from public.compatibility_authorizations where credential_id=v_entry_cred2)=array['node-entry'];
      assert (select array_agg(node_id) from public.compatibility_authorizations where credential_id=v_exit_cred2)=array['node-exit'];
      -- The real regression this migration fixes: hop 2's rotation must
      -- trace back to hop 2's own prior generation, never hop 1's -- the
      -- device-scoped (not hop-scoped) trigger this replaces would have
      -- made whichever hop inserted second look like a rotation of
      -- whichever was inserted first.
      assert (select generation=2 and rotated_from=v_entry_cred_row from public.compatibility_credentials
        where credential_id=v_entry_cred2), 'entry hop rotation has the wrong lineage';
      assert (select generation=2 and rotated_from=v_exit_cred_row from public.compatibility_credentials
        where credential_id=v_exit_cred2), 'exit hop rotation has the wrong lineage';
    end;
  end;
end $$;
rollback;
