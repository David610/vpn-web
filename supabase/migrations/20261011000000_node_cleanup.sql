-- Phase 8 remediation (F-audit 2026-09-27, "no cleanup job for abandoned
-- FAILED nodes"): abandoned FAILED/RETIRED nodes were "kept for
-- inspection" -- no code path ever destroyed their provider instance or
-- confirmed the full lifecycle-cleanup end state, which is leaked cost
-- (a billed VPS running forever) and attack surface (a still-running,
-- possibly-compromised host nobody is watching).
--
-- This migration adds:
--   1. nodes.provider_instance_destroyed_at -- tracks whether the
--      abandoned-node cleanup saga has confirmed the provider instance is
--      gone, mirroring dns_removed_at's existing role for F-06. NULL means
--      "not yet destroyed (or nothing to destroy)"; a timestamp is a
--      confirmed, idempotent terminal fact, same contract as
--      dns_removed_at/retired_at.
--   2. register_cleanup_operation() -- registers a CLEANUP_ABANDONED_NODE
--      fleet_operations saga (functions/lib/fleet-operations.js) for an
--      EXISTING node (unlike register_node_create_operation /
--      register_node_replace_operation, this never inserts a nodes row).
--      Idempotent on node_id via idempotency_key
--      'CLEANUP_ABANDONED_NODE:<node_id>' -- a second sweep tick for a node
--      whose cleanup operation already exists returns that same operation
--      instead of erroring, so the periodic sweep can call this
--      unconditionally every time it finds an eligible node.

alter table public.nodes add column provider_instance_destroyed_at timestamptz;

create or replace function public.register_cleanup_operation(
  p_node_id text,
  p_steps text[],
  p_deadline_at timestamptz
)
returns public.fleet_operations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op public.fleet_operations;
  v_key text := 'CLEANUP_ABANDONED_NODE:' || p_node_id;
begin
  select * into v_op from public.fleet_operations where idempotency_key = v_key;
  if found then
    return v_op;
  end if;

  insert into public.fleet_operations (type, node_id, idempotency_key, detail, deadline_at)
  values ('CLEANUP_ABANDONED_NODE', p_node_id, v_key, '{}'::jsonb, p_deadline_at)
  returning * into v_op;

  insert into public.operation_steps (operation_id, step_index, name, node_id)
  select v_op.id, s.ord - 1, s.name, p_node_id
  from unnest(p_steps) with ordinality as s(name, ord);

  return v_op;
exception when unique_violation then
  select * into v_op from public.fleet_operations where idempotency_key = v_key;
  return v_op;
end;
$$;

revoke all on function public.register_cleanup_operation(text, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_cleanup_operation(text, text[], timestamptz)
  to service_role;
