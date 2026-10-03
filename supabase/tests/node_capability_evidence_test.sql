do $$
begin
  assert exists (select 1 from information_schema.columns where table_schema='public' and table_name='nodes' and column_name='capabilities_reported_at'), 'capability timestamp exists';
  assert exists (select 1 from pg_constraint where conrelid='public.nodes'::regclass and pg_get_constraintdef(oid) like '%provisioning_protocol%65535%'), 'protocol is bounded';
  assert public.claim_token_lease_seconds() = 600, 'canonical server claim lease remains 600 seconds';
  assert public.claim_token_lease_seconds() >= 300, 'server lease satisfies the merged node minimum';
end $$;
