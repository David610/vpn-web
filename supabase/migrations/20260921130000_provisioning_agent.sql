-- nodes — one row per VPS the provisioning agent runs on. Only the sha256
-- hash of each node's shared secret is stored; the raw key is generated
-- once by scripts/register-node.mjs and pasted into that VPS's agent
-- config. service_role only — never exposed to anon/authenticated, same
-- revoke-by-default pattern as vpn_secrets/stripe_events.
create table public.nodes (
  node_id text primary key,
  api_key_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.nodes enable row level security;
revoke all on public.nodes from anon, authenticated;

-- claim_next_job — atomically claims the oldest pending job for a given
-- node_id. FOR UPDATE SKIP LOCKED is what makes this safe under
-- concurrent callers (two nodes, or a client retrying a slow request):
-- a row already locked by another in-flight claim is simply skipped,
-- never double-claimed. security definer is standard practice for this
-- row-skipping pattern; there is no grant for anon/authenticated to call
-- it directly (revoked below), so this is not a client-facing privilege
-- escalation — only the Worker's service-role code calls it, and only
-- after authenticating the caller's node key itself.
create or replace function public.claim_next_job(p_node_id text)
returns setof public.provisioning_jobs
language sql
security definer
set search_path = ''
as $$
  update public.provisioning_jobs
  set status = 'claimed', claimed_at = now()
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

revoke all on all sequences in schema public from anon, authenticated;
