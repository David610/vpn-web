-- Fleet Phase 12a: replace-node workflow.
--
-- 1. lifecycle_state_changed_at lets the auto-replace check (fleet-tick.js,
--    Task 6) ask "how long has this node been FAILED", something nothing
--    in the schema could answer before -- lifecycle_state itself carries no
--    timestamp of its own transition. Every existing write path that sets
--    lifecycle_state is updated in the same phase (Task 2) to also set this
--    column, so it is never stale for any node regardless of which code
--    path moved it.
-- 2. register_node_replace_operation() mirrors register_node_create_operation()
--    (20260925000000_node_bootstrap.sql): registers a PROVISIONING new node
--    together with its REPLACE_NODE operation and steps in one transaction.
--    Detail carries oldNodeId/maxWaitHours merged into the caller's
--    provider/region detail, matching CREATE_NODE's detail shape so the six
--    reused CREATE_NODE_HANDLERS need no special-casing to read
--    detail.provider/detail.region.

alter table public.nodes
  add column lifecycle_state_changed_at timestamptz;

update public.nodes set lifecycle_state_changed_at = now();

alter table public.nodes
  alter column lifecycle_state_changed_at set not null,
  alter column lifecycle_state_changed_at set default now();

create or replace function public.register_node_replace_operation(
  p_node_id text,
  p_role text,
  p_location_id uuid,
  p_provider text,
  p_hostname text,
  p_detail jsonb,
  p_old_node_id text,
  p_max_wait_hours integer,
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
  insert into public.nodes (node_id, role, location_id, lifecycle_state, provider, hostname, lifecycle_state_changed_at)
  values (p_node_id, p_role, p_location_id, 'PROVISIONING', p_provider, p_hostname, now());

  insert into public.fleet_operations (type, node_id, idempotency_key, detail, deadline_at)
  values (
    'REPLACE_NODE',
    p_node_id,
    'REPLACE_NODE:' || p_old_node_id,
    p_detail || jsonb_build_object('oldNodeId', p_old_node_id, 'maxWaitHours', p_max_wait_hours),
    p_deadline_at
  )
  returning * into v_op;

  insert into public.operation_steps (operation_id, step_index, name, node_id)
  select v_op.id, s.ord - 1, s.name, p_node_id
  from unnest(p_steps) with ordinality as s(name, ord);

  return v_op;
end;
$$;

revoke all on function public.register_node_replace_operation(text, text, uuid, text, text, jsonb, text, integer, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_node_replace_operation(text, text, uuid, text, text, jsonb, text, integer, text[], timestamptz)
  to service_role;
