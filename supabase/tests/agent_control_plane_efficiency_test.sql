-- 20261018000000: batch entitlement + wake-token functions used by the VPS-hosted
-- agent API (Cloudflare quota remediation).
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'wake-one@example.com');

insert into public.nodes (node_id, api_key_hash, lifecycle_state) values
  ('wake-node-1', 'wake-h1', 'READY'),
  ('wake-node-2', 'wake-h2', 'READY');

do $$
declare
  acct uuid := (select account_id from public.account_members where user_id = '00000000-0000-4000-8000-0000000000f1');
  sub bigint;
  d_ok uuid;
  d_over uuid;
  d_ghost uuid := '00000000-0000-4000-8000-00000000dead';
  r record;
  before_tokens record;
  after_tokens record;
  n int;
begin
  insert into public.subscriptions (account_id, stripe_subscription_id, status, name, extra_seats, current_period_end)
    values (acct, 'sub_wake', 'active', 'W', 0, now() + interval '30 days') returning id into sub;
  insert into public.devices (account_id, user_id, name, subscription_id)
    values (acct, '00000000-0000-4000-8000-0000000000f1', 'ok', sub) returning id into d_ok;
  insert into public.devices (account_id, user_id, name, subscription_id)
    values (acct, '00000000-0000-4000-8000-0000000000f1', 'o2', sub);
  insert into public.devices (account_id, user_id, name, subscription_id)
    values (acct, '00000000-0000-4000-8000-0000000000f1', 'o3', sub);
  insert into public.devices (account_id, user_id, name, subscription_id)
    values (acct, '00000000-0000-4000-8000-0000000000f1', 'over', sub) returning id into d_over;

  -- batch agrees with the single-device function, row for row
  for r in select * from public.device_entitlements_batch(array[d_ok, d_over, d_ghost]) loop
    if r.entitled is distinct from (select e.entitled from public.device_entitlement(r.device_id) e limit 1) and r.device_id <> d_ghost then
      raise exception 'batch disagrees with device_entitlement for %', r.device_id;
    end if;
  end loop;
  select count(*) into n from public.device_entitlements_batch(array[d_ok, d_over, d_ghost]);
  if n <> 3 then raise exception 'batch must return one row per requested id, got %', n; end if;
  if (select entitled from public.device_entitlements_batch(array[d_ghost])) then
    raise exception 'unknown device must fail closed';
  end if;
  if (select entitled from public.device_entitlements_batch(array[d_over])) then
    raise exception 'device over capacity must not be entitled';
  end if;
  if not (select entitled from public.device_entitlements_batch(array[d_ok])) then
    raise exception 'device within capacity must be entitled';
  end if;
  if (select count(*) from public.device_entitlements_batch(array[]::uuid[])) <> 0 then
    raise exception 'empty input must return no rows';
  end if;

  -- cancelling the subscription flips every device in the batch
  update public.subscriptions set status = 'canceled' where id = sub;
  if exists (select 1 from public.device_entitlements_batch(array[d_ok, d_over]) where entitled) then
    raise exception 'canceled subscription must entitle nobody';
  end if;

  -- wake tokens: one row per requested node, stable until something changes
  select * into before_tokens from public.agent_wake_tokens(array['wake-node-1','wake-node-2']) where node_id = 'wake-node-1';
  if before_tokens.jobs_token <> '0:0' then raise exception 'idle node must report 0:0, got %', before_tokens.jobs_token; end if;
  if before_tokens.auth_revision <> 0 then raise exception 'no authorization state => revision 0'; end if;
  select count(*) into n from public.agent_wake_tokens(array['wake-node-1','wake-node-2']);
  if n <> 2 then raise exception 'one row per node expected'; end if;
  select * into after_tokens from public.agent_wake_tokens(array['wake-node-1']);
  if after_tokens is distinct from before_tokens then raise exception 'tokens must be stable without changes'; end if;

  -- a pending job moves ONLY its own node's jobs token
  insert into public.provisioning_jobs (idempotency_key, node_id, job_type, payload)
    values ('wake-job-1', 'wake-node-1', 'CREATE_USER', '{}');
  select * into after_tokens from public.agent_wake_tokens(array['wake-node-1']);
  if after_tokens.jobs_token = before_tokens.jobs_token then raise exception 'pending job did not move the token'; end if;
  if (select jobs_token from public.agent_wake_tokens(array['wake-node-2'])) <> '0:0' then
    raise exception 'job for node 1 leaked into node 2';
  end if;
  -- claiming it removes it from the pending set
  perform public.claim_next_job('wake-node-1');
  if (select jobs_token from public.agent_wake_tokens(array['wake-node-1'])) <> '0:0' then
    raise exception 'claimed job must leave the pending token';
  end if;

  -- lease revocation moves the lease token
  insert into public.node_lease_slots (node_id, slot, generation, valid_until, credential_ciphertext, credential_nonce, state)
    values ('wake-node-1', 0, 1, now() + interval '10 minutes', 'c', 'n', 'active');
  select * into before_tokens from public.agent_wake_tokens(array['wake-node-1']);
  update public.node_lease_slots set state = 'revoked', urgent = true where node_id = 'wake-node-1' and slot = 0;
  select * into after_tokens from public.agent_wake_tokens(array['wake-node-1']);
  if after_tokens.lease_token = before_tokens.lease_token then raise exception 'revocation did not move the lease token'; end if;

  -- entitlement tokens: present for every node, deterministic, no secrets
  if (select count(*) from public.agent_entitlement_tokens(array['wake-node-1','wake-node-2'])) <> 2 then
    raise exception 'one entitlement token per node expected';
  end if;
  if (select entitlement_token from public.agent_entitlement_tokens(array['wake-node-1']))
     is distinct from (select entitlement_token from public.agent_entitlement_tokens(array['wake-node-1'])) then
    raise exception 'entitlement token must be deterministic';
  end if;
  if (select entitlement_token from public.agent_entitlement_tokens(array['wake-node-1'])) !~ '^[0-9a-f]{32}$' then
    raise exception 'entitlement token must be an md5 hex digest';
  end if;

  -- authenticated/anon cannot call any of the three
  if has_function_privilege('authenticated', 'public.agent_wake_tokens(text[])', 'execute')
     or has_function_privilege('anon', 'public.agent_entitlement_tokens(text[])', 'execute')
     or has_function_privilege('authenticated', 'public.device_entitlements_batch(uuid[])', 'execute') then
    raise exception 'client roles must not execute the agent functions';
  end if;
  if not has_function_privilege('service_role', 'public.agent_wake_tokens(text[])', 'execute') then
    raise exception 'service_role must execute the agent functions';
  end if;
end $$;

rollback;
