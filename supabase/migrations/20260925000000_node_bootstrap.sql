-- Automated node bootstrap (fleet integration, spec 54 Phase 4 completion).
--
-- 1. nodes.api_key_hash becomes unique. Node API keys are now generated ON
--    the node (functions/api/agent/enroll.js binds only their SHA-256), and
--    node-auth.js resolves a node by this hash with maybeSingle() -- two
--    rows sharing one hash would make authentication ambiguous. Partial
--    because PROVISIONING nodes have none yet.
-- 2. nodes gets the DNS name the control plane publishes for it, the DNS
--    provider's record id (so the record can be updated/removed without a
--    name search), and the last bootstrap stage the node itself reported.
-- 3. fleet_operations/operation_steps get what a resumable, lease-based
--    reconciler needs: which node an operation is about, retry bookkeeping,
--    a lease so two concurrent ticks never advance the same operation, and
--    a free-form, credential-free detail/error per step.

create unique index nodes_api_key_hash_uniq
  on public.nodes (api_key_hash)
  where api_key_hash is not null;

alter table public.nodes
  add column hostname text unique,
  add column dns_record_id text,
  add column bootstrap_stage text,
  add column bootstrap_status text check (bootstrap_status in ('RUNNING', 'OK', 'FAILED')),
  add column bootstrap_message text check (char_length(bootstrap_message) <= 500),
  add column bootstrap_updated_at timestamptz;

alter table public.fleet_operations
  add column node_id text references public.nodes (node_id) on delete set null,
  add column attempts integer not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column lease_until timestamptz,
  add column last_error text check (char_length(last_error) <= 1000),
  add column deadline_at timestamptz,
  add column detail jsonb not null default '{}'::jsonb;

create index fleet_operations_due_idx
  on public.fleet_operations (next_attempt_at)
  where status in ('PENDING', 'RUNNING');
create index fleet_operations_node_id_idx on public.fleet_operations (node_id);

alter table public.operation_steps
  add column name text,
  add column started_at timestamptz,
  add column attempts integer not null default 0,
  add column error text check (char_length(error) <= 1000);

-- Leases up to p_limit due operations to one caller. SKIP LOCKED plus the
-- lease timestamp means two overlapping reconciler ticks (a slow tick and
-- the next cron firing) never advance the same operation concurrently; a
-- caller that dies mid-operation simply lets its lease lapse.
create or replace function public.lease_fleet_operations(p_limit integer, p_lease_seconds integer)
returns setof public.fleet_operations
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.fleet_operations f
     set lease_until = now() + make_interval(secs => p_lease_seconds),
         status = case when f.status = 'PENDING' then 'RUNNING' else f.status end
   where f.id in (
     select id from public.fleet_operations
      where status in ('PENDING', 'RUNNING')
        and next_attempt_at <= now()
        and (lease_until is null or lease_until < now())
      order by next_attempt_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked
   )
  returning f.*;
end;
$$;

revoke all on function public.lease_fleet_operations(integer, integer) from public, anon, authenticated;
grant execute on function public.lease_fleet_operations(integer, integer) to service_role;

-- Registers a PROVISIONING node together with its CREATE_NODE operation and
-- steps in ONE transaction, so a failure can never leave a node row with no
-- operation driving it (which a retry would then reject as a duplicate).
create or replace function public.register_node_create_operation(
  p_node_id text,
  p_role text,
  p_location_id uuid,
  p_provider text,
  p_hostname text,
  p_detail jsonb,
  p_steps text[],
  p_deadline_at timestamptz
)
returns public.fleet_operations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op public.fleet_operations;
begin
  insert into public.nodes (node_id, role, location_id, lifecycle_state, provider, hostname)
  values (p_node_id, p_role, p_location_id, 'PROVISIONING', p_provider, p_hostname);

  insert into public.fleet_operations (type, node_id, idempotency_key, detail, deadline_at)
  values ('CREATE_NODE', p_node_id, 'CREATE_NODE:' || p_node_id, p_detail, p_deadline_at)
  returning * into v_op;

  insert into public.operation_steps (operation_id, step_index, name, node_id)
  select v_op.id, s.ord - 1, s.name, p_node_id
  from unnest(p_steps) with ordinality as s(name, ord);

  return v_op;
end;
$$;

revoke all on function public.register_node_create_operation(text, text, uuid, text, text, jsonb, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_node_create_operation(text, text, uuid, text, text, jsonb, text[], timestamptz)
  to service_role;
