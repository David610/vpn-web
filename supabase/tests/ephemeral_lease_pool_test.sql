-- ADR-0003 lease pool: atomic multi-hop leasing, exhaustion, idempotency,
-- rate limit, expiry, revocation, agent sync. Runs against the migrated
-- schema, same convention as the other files here; rolled back at the end.
begin;

insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000c3', 'lease@example.com');
insert into public.nodes (node_id, api_key_hash) values ('relay-1', 'h1'), ('exit-1', 'h2');

do $$
declare
  acct uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000c3');
  dev uuid;
  dev2 uuid;
  r jsonb;
  r2 jsonb;
  n integer;
  slots jsonb;
begin
  insert into public.devices (account_id, user_id, name)
    values (acct, '00000000-0000-4000-8000-0000000000c3', 'Phone') returning id into dev;
  insert into public.devices (account_id, user_id, name)
    values (acct, '00000000-0000-4000-8000-0000000000c3', 'Laptop') returning id into dev2;

  -- Agent sync: relay gets 1 slot, exit gets none yet. New generations without
  -- ciphertext are requested, not stored.
  r := public.agent_sync_lease_slots('relay-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 1, 'valid_until', now() + interval '15 minutes',
      'credential_ciphertext', '\x01', 'credential_nonce', '\x02')));
  assert r -> 'slots' = '[{"slot":0,"generation":1,"state":"active"}]'::jsonb, 'relay slot active';
  r := public.agent_sync_lease_slots('exit-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 1, 'valid_until', now() + interval '15 minutes')));
  assert r -> 'need_secret' = '[0]'::jsonb, 'secret requested';
  assert (select count(*) from public.node_lease_slots where node_id = 'exit-1') = 0, 'nothing stored without secret';

  -- Privacy+ with an empty exit pool: exhausted, and the relay slot is untouched.
  r := public.lease_route_slots(null, dev, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r ->> 'status' = 'exhausted' and r ->> 'node_id' = 'exit-1', 'pp exhausted on exit: ' || r::text;
  assert (select state from public.node_lease_slots where node_id = 'relay-1') = 'active', 'no partial relay lease';
  assert (select count(*) from public.vpn_leases) = 0, 'no lease row on exhaustion';

  -- Exit slot confirmed (short-lived) -> Privacy+ leases both, expires at the earlier end.
  perform public.agent_sync_lease_slots('exit-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 1, 'valid_until', now() + interval '12 minutes',
      'credential_ciphertext', '\x03', 'credential_nonce', '\x04')));
  r := public.lease_route_slots('key-1', dev, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r ->> 'status' = 'ok', 'pp ok: ' || r::text;
  assert jsonb_array_length(r -> 'hops') = 2 and r -> 'hops' -> 0 ->> 'node_id' = 'relay-1', 'hop order';
  assert (r ->> 'expires_at')::timestamptz = (select valid_until from public.node_lease_slots where node_id = 'exit-1'), 'earliest end';
  assert (select count(*) from public.node_lease_slots where state = 'leased') = 2, 'both leased';

  -- Idempotent replay: same lease, no new row.
  r2 := public.lease_route_slots('key-1', dev, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'ok' and (r2 ->> 'replay')::boolean and r2 ->> 'lease_id' = r ->> 'lease_id', 'replay';
  assert (select count(*) from public.vpn_leases) = 1, 'replay made no row';
  -- Same key, other device/route: conflict.
  r2 := public.lease_route_slots('key-1', dev2, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'conflict', 'conflict';

  -- Pool now exhausted (single-use slots).
  r2 := public.lease_route_slots(null, dev2, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'exhausted', 'single use';

  -- Slots under the minimum remaining lifetime are never leased.
  perform public.agent_sync_lease_slots('exit-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 1, 'valid_until', now() + interval '12 minutes'),
    jsonb_build_object('slot', 1, 'generation', 1, 'valid_until', now() + interval '5 minutes',
      'credential_ciphertext', '\x05', 'credential_nonce', '\x06')));
  r2 := public.lease_route_slots(null, dev2, acct, 'route-fast', array['exit-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'exhausted', 'min remaining';

  -- Revocation marks both slots revoked; agent sync reports it; replay is dead.
  n := public.revoke_device_leases(dev);
  assert n = 1, 'one lease revoked';
  assert (select count(*) from public.node_lease_slots where state = 'revoked') = 2, 'slots revoked';
  r2 := public.lease_route_slots('key-1', dev, acct, 'route-pp', array['relay-1', 'exit-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'exhausted', 'revoked lease not replayed: ' || r2::text;

  -- Agent rotates the revoked relay slot (generation 2): leasable again.
  -- A stale snapshot (generation 1) never goes backwards.
  perform public.agent_sync_lease_slots('relay-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 2, 'valid_until', now() + interval '15 minutes',
      'credential_ciphertext', '\x07', 'credential_nonce', '\x08')));
  perform public.agent_sync_lease_slots('relay-1', jsonb_build_array(
    jsonb_build_object('slot', 0, 'generation', 1, 'valid_until', now() + interval '15 minutes',
      'credential_ciphertext', '\x01', 'credential_nonce', '\x02')));
  assert (select generation || state from public.node_lease_slots where node_id = 'relay-1') = '2active', 'rotated + monotonic';

  -- Rate limit: device limit 1 within the window -> second new lease refused.
  perform public.agent_sync_lease_slots('relay-1', (select jsonb_agg(jsonb_build_object(
    'slot', g, 'generation', 3, 'valid_until', now() + interval '15 minutes',
    'credential_ciphertext', '\x09', 'credential_nonce', '\x0a')) from generate_series(0, 3) g));
  r2 := public.lease_route_slots(null, dev2, acct, 'route-r', array['relay-1'], 600, 1, 60, 600);
  assert r2 ->> 'status' = 'ok', 'first under limit';
  r2 := public.lease_route_slots(null, dev2, acct, 'route-r', array['relay-1'], 600, 1, 60, 600);
  assert r2 ->> 'status' = 'rate_limited', 'device rate limit: ' || r2::text;

  -- Expired lease is not replayed; its key is released for a fresh lease.
  update public.vpn_leases set expires_at = now() - interval '1 second' where idempotency_key = 'key-1';
  r2 := public.lease_route_slots('key-1', dev, acct, 'route-pp2', array['relay-1'], 600, 20, 60, 600);
  assert r2 ->> 'status' = 'ok' and not (r2 ->> 'replay')::boolean, 'expired key reused: ' || r2::text;

  -- Pool shrink deletes slots the node dropped.
  perform public.agent_sync_lease_slots('relay-1', '[]'::jsonb);
  assert (select count(*) from public.node_lease_slots where node_id = 'relay-1') = 0, 'shrink';
end $$;

-- Service-role only.
do $$
begin
  assert not has_table_privilege('anon', 'public.vpn_leases', 'select'), 'anon cannot read leases';
  assert not has_table_privilege('authenticated', 'public.node_lease_slots', 'select'), 'authenticated cannot read slots';
  assert not has_function_privilege('authenticated', 'public.lease_route_slots(text, uuid, uuid, text, text[], integer, integer, integer, integer)', 'execute'), 'no rpc for users';
  assert not has_function_privilege('anon', 'public.agent_sync_lease_slots(text, jsonb)', 'execute'), 'no rpc for anon';
  assert not has_table_privilege('authenticated', 'public.node_transport_secrets', 'select'), 'no obfs secrets for users';
  assert not has_function_privilege('authenticated', 'public.revoke_device_leases(uuid)', 'execute'), 'no revoke rpc for users';
end $$;

select 'ephemeral_lease_pool_test: ok' as result;
rollback;
