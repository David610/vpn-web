-- I-100: effective entitlement changes advance the node snapshot revision exactly once,
-- in both directions (lapse AND renewal), without touching compatibility_authorizations.
begin;

insert into public.nodes(node_id,api_key_hash,location_id,lifecycle_state,provider,hostname)
values ('node-rev-1',repeat('7',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-rev-1.example.test'),
       ('node-rev-2',repeat('8',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-rev-2.example.test'),
       ('node-rev-empty',repeat('9',64),'00000000-0000-4000-8000-000000000000','READY','mock','node-rev-empty.example.test');
insert into public.logical_routes(id,region,privacy_class,display_name)
values ('route_rev_one','rev-one','fast','Rev one'),('route_rev_two','rev-two','fast','Rev two');
insert into public.logical_route_targets(route_id,hop,node_id,priority)
values ('route_rev_one',1,'node-rev-1',100),('route_rev_two',1,'node-rev-2',100);

do $$
declare
  v_user uuid := '11111111-1111-1111-1111-111111111111';
  v_account uuid := (select account_id from public.account_members where user_id=v_user);
  v_sub bigint; v_prefix text; r0 bigint; r1 bigint; r2 bigint; r3 bigint; r4 bigint; other0 bigint; other1 bigint; v_json jsonb;
begin
  insert into public.subscriptions(account_id,stripe_subscription_id,status,name,extra_seats,current_period_end)
    values(v_account,'sub_rev','active','Rev',0,now()+interval '30 days') returning id into v_sub;
  v_prefix := lpad('rev1',43,'a');
  perform public.create_external_vpn_device(v_account,v_user,v_sub,'Rev device','hiddify','ext_'||v_prefix,
    encode(extensions.gen_random_bytes(32),'hex'),'route_rev_one',
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||v_prefix,'credential_ciphertext','cipher','credential_nonce','nonce')),
    now()+interval '7 days');
  v_prefix := lpad('rev2',43,'b');
  perform public.create_external_vpn_device(v_account,v_user,v_sub,'Other node device','hiddify','ext_'||v_prefix,
    encode(extensions.gen_random_bytes(32),'hex'),'route_rev_two',
    jsonb_build_array(jsonb_build_object('hop',1,'credential_id','cred_'||v_prefix,'credential_ciphertext','cipher','credential_nonce','nonce')),
    now()+interval '7 days');

  -- first observation records the digest (one bump), a second read is a no-op
  select snapshot_revision into r0 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  select snapshot_revision into r1 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r1 = r0, 'an unchanged entitlement must not advance the revision';
  select snapshot_revision into other0 from public.get_compatibility_authorization_snapshot_synced('node-rev-2');

  -- LAPSE: no compatibility_authorizations row is written, the revision must move once
  update public.subscriptions set status='canceled' where id=v_sub;
  select snapshot_revision into r2 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r2 = r1 + 1, format('lapse must advance the revision by exactly 1 (was %s, now %s)', r1, r2);
  select snapshot_revision into r2 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r2 = r1 + 1, 'repeating the read after a lapse must not advance again';

  -- RENEWAL: the case the agent could not previously apply (un-revoke needs a higher revision)
  update public.subscriptions set status='active' where id=v_sub;
  select snapshot_revision into r3 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r3 = r2 + 1, format('renewal must advance the revision by exactly 1 (was %s, now %s)', r2, r3);
  select snapshot_revision into r4 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r4 = r3, 'repeating the read after a renewal must not advance again';

  -- isolation: node 2 shared the same subscription and legitimately flipped too, but a node
  -- with no authorizations is never touched
  select snapshot_revision into other1 from public.get_compatibility_authorization_snapshot_synced('node-rev-empty');
  assert other1 = 0, 'a node without authorizations has revision 0';
  assert not exists(select 1 from public.compatibility_authorization_node_state where node_id='node-rev-empty'),
    'reading an empty node must not create state';

  -- the snapshot rows themselves are unchanged by the sync (same shape as the plain read)
  select authorizations into v_json from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert jsonb_array_length(v_json) = 1, 'one authorization row expected';
  assert (select authorizations from public.get_compatibility_authorization_snapshot('node-rev-1')) = v_json,
    'synced and plain reads must return identical rows';

  -- a trigger-driven change (write to compatibility_authorizations) still advances independently
  update public.compatibility_authorizations set revoked=true where node_id='node-rev-1';
  select snapshot_revision into r4 from public.get_compatibility_authorization_snapshot_synced('node-rev-1');
  assert r4 > r3, 'a direct authorization write must still advance the revision';

  -- privileges: service_role only
  assert not has_function_privilege('authenticated','public.get_compatibility_authorization_snapshot_synced(text)','execute')
     and not has_function_privilege('anon','public.get_compatibility_authorization_snapshot_synced(text)','execute'),
     'client roles must not execute the synced snapshot function';
  assert has_function_privilege('service_role','public.get_compatibility_authorization_snapshot_synced(text)','execute'),
     'service_role must execute it';
end $$;

rollback;
