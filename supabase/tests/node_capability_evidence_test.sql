do $$
declare
  v_claimed public.provisioning_jobs;
begin
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='nodes' and column_name='capabilities_reported_at'), 'capability timestamp exists';
  assert exists (select 1 from pg_constraint where conrelid='public.nodes'::regclass and pg_get_constraintdef(oid) like '%provisioning_protocol%65535%'), 'protocol is bounded';
  assert public.claim_token_lease_seconds() = 600, 'canonical server claim lease remains 600 seconds';
  assert public.claim_token_lease_seconds() >= 300, 'server lease satisfies the merged node minimum';
  insert into public.provisioning_jobs(idempotency_key, node_id, job_type, payload)
    values ('capability-lease-proof', 'lease-proof-node', 'CREATE_USER', '{}'::jsonb);
  select * into v_claimed from public.claim_next_job('lease-proof-node');
  assert v_claimed.claim_token is not null, 'claim token issued';
  assert v_claimed.lease_expires_at = v_claimed.claimed_at + make_interval(secs => public.claim_token_lease_seconds()),
    'claim_next_job lease uses canonical lease function exactly';
end $$;
