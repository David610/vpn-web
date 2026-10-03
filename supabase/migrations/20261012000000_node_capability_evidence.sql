-- Normalized, bounded evidence from arcana.node.capabilities.v1 heartbeats.
alter table public.nodes
  add column capability_contract text check (char_length(capability_contract) between 1 and 128),
  add column provisioning_protocol integer check (provisioning_protocol between 0 and 65535),
  add column claim_token_version integer check (claim_token_version between 0 and 65535),
  add column claim_token_minimum_lease_seconds integer check (claim_token_minimum_lease_seconds between 0 and 86400),
  add column external_authorization_snapshot_version integer check (external_authorization_snapshot_version between 0 and 65535),
  add column capabilities_reported_at timestamptz,
  add column capability_report_error text check (char_length(capability_report_error) <= 256),
  add column capability_report_error_at timestamptz,
  add column singbox_alive boolean;

create index nodes_capability_fleet_idx on public.nodes (lifecycle_state, capabilities_reported_at);

-- Single database-visible source for the lease stamped by claim_next_job.
create function public.claim_token_lease_seconds() returns integer
language sql immutable security definer set search_path = '' as $$ select 600 $$;
revoke all on function public.claim_token_lease_seconds() from anon, authenticated, public;
grant execute on function public.claim_token_lease_seconds() to service_role;

create or replace function public.claim_next_job(p_node_id text)
returns setof public.provisioning_jobs
language sql security definer set search_path = '' as $$
  update public.provisioning_jobs
  set status = 'claimed', claimed_at = now(), claim_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => public.claim_token_lease_seconds())
  where id = (
    select id from public.provisioning_jobs where node_id = p_node_id and status = 'pending'
    order by created_at asc limit 1 for update skip locked
  ) returning *;
$$;
revoke all on function public.claim_next_job(text) from anon, authenticated, public;
