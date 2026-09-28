-- F-09/D-03/C-10: claimed provisioning_jobs are never re-queued. One agent
-- crash between claim and complete/fail permanently stalls that device's
-- provisioning on that node -- silently, with nothing to reclaim it.
--
-- Adds the claim-token lease contract from C-10:
--   * claim_next_job now stamps a fresh claim_token + lease_expires_at
--     (10 minutes) on every claim, and returns them to the agent.
--   * complete/fail must echo the token; accepted only while the job is
--     still `claimed`, the token matches, and the lease has not expired.
--   * a fleet-tick reaper (reap_expired_job_claims) re-queues an expired
--     claim as `pending` with attempts+1, or `failed` once attempts >= 5.
--
-- `cancelled` is added to the status check constraint: contract C-09/C-12
-- use it (QUARANTINE transitions, superseded state-sync jobs); it did not
-- exist before this migration (previously only pending/claimed/done/failed).
alter table public.provisioning_jobs
  add column claim_token uuid,
  add column lease_expires_at timestamptz,
  add column attempts integer not null default 0;

alter table public.provisioning_jobs
  drop constraint provisioning_jobs_status_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_status_check
  check (status in ('pending', 'claimed', 'done', 'failed', 'cancelled'));

create index provisioning_jobs_lease_expiry_idx
  on public.provisioning_jobs (lease_expires_at)
  where status = 'claimed';

-- claim_next_job: now stamps a claim_token + 10-minute lease on the row it
-- claims and returns them, so the caller (functions/api/agent/claim.js) can
-- hand both to the agent. Same SKIP LOCKED shape as before, still
-- service-role-only (no grant added for anon/authenticated).
create or replace function public.claim_next_job(p_node_id text)
returns setof public.provisioning_jobs
language sql
security definer
set search_path = ''
as $$
  update public.provisioning_jobs
  set status = 'claimed',
      claimed_at = now(),
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + interval '10 minutes'
  where id = (
    select id from public.provisioning_jobs
    where node_id = p_node_id and status = 'pending'
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_next_job(text) from anon, authenticated, public;

-- reap_expired_job_claims: called once a minute from fleet-tick alongside
-- the existing silence sweep. A claim whose lease has expired means the
-- agent that claimed it is presumed dead (crashed, network partition, or
-- simply never came back) -- per the singbox-vpn side of this contract,
-- every job's on-node side effect is idempotent to retry (CREATE_USER
-- keyed by idempotency_key returns the existing user; DISABLE/ENABLE_USER
-- are naturally idempotent), so re-queuing as `pending` is always safe.
-- attempts >= 5 gives up and marks the job `failed` instead of looping
-- forever against a node that will never come back; the caller is
-- responsible for raising an alert for each such row (this function only
-- returns them).
create or replace function public.reap_expired_job_claims(p_max_attempts integer default 5)
returns table (
  id bigint,
  job_type text,
  node_id text,
  vpn_account_id bigint,
  attempts integer,
  new_status text
)
language sql
security definer
set search_path = ''
as $$
  update public.provisioning_jobs j
  set status = case when j.attempts + 1 >= p_max_attempts then 'failed' else 'pending' end,
      attempts = j.attempts + 1,
      claim_token = null,
      lease_expires_at = null,
      claimed_at = null,
      completed_at = case when j.attempts + 1 >= p_max_attempts then now() else j.completed_at end
  where j.status = 'claimed'
    and j.lease_expires_at is not null
    and j.lease_expires_at < now()
  returning j.id, j.job_type, j.node_id, j.vpn_account_id, j.attempts,
    case when j.attempts >= p_max_attempts then 'failed' else 'pending' end as new_status;
$$;

revoke all on function public.reap_expired_job_claims(integer) from anon, authenticated, public;
