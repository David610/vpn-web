-- F-05/C-09: node key revocation must be atomic with a QUARANTINED/RETIRED
-- lifecycle transition. Before this migration, admin/nodes/:id/lifecycle.js
-- did the transition as one UPDATE and left the node's api_key_hash and
-- revoked_at untouched, its pending/claimed provisioning_jobs untouched,
-- and its node_lease_slots untouched -- a quarantined/retired node's agent
-- (or anyone holding its leaked key) could keep authenticating with the
-- OLD key until something else got around to clearing api_key_hash, and
-- any job already claimed by it would sit "claimed" forever.
--
-- This RPC performs the whole thing -- lifecycle transition, key
-- revocation, job cancellation, lease-slot deletion, and a route-directory
-- version bump -- as one transaction. It only knows the two transitions
-- that must revoke a key; every other transition (READY<->DEGRADED etc.)
-- keeps going through the plain UPDATE path in lifecycle.js unchanged.

create or replace function public.revoke_node_key_and_transition(
  p_node_id text,
  p_to_state text,
  p_expected_from_state text,
  p_override_dns_check boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_node public.nodes;
  v_cancelled integer;
  v_leases_deleted integer;
begin
  if p_to_state not in ('QUARANTINED', 'RETIRED') then
    raise exception 'revoke_node_key_and_transition: p_to_state must be QUARANTINED or RETIRED, got %', p_to_state;
  end if;

  select * into v_node from public.nodes where node_id = p_node_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Optimistic-concurrency guard, same contract as the plain lifecycle
  -- UPDATE path: the caller validated canTransitionLifecycle(from, to) in
  -- application code against p_expected_from_state; if the row has since
  -- moved, refuse rather than silently apply a stale decision.
  if v_node.lifecycle_state <> p_expected_from_state then
    return jsonb_build_object('status', 'stale', 'lifecycle_state', v_node.lifecycle_state);
  end if;

  -- F-06: RETIRED must not be reachable while the node's DNS record is
  -- still published -- that is exactly the dangling-record window a
  -- subdomain takeover exploits. The automated REPLACE_NODE path
  -- (fleet-operations.js's RETIRE_OLD_NODE) always sets dns_removed_at
  -- before its own RETIRED transition, so this only ever fires for a
  -- manual admin retirement of a node whose DNS was never programmatically
  -- published (or removal genuinely failed) -- hence the explicit,
  -- audited override rather than silently skipping the check.
  if p_to_state = 'RETIRED' and v_node.dns_removed_at is null and not p_override_dns_check then
    return jsonb_build_object('status', 'dns_not_removed');
  end if;

  update public.nodes
     set lifecycle_state = p_to_state,
         lifecycle_state_changed_at = now(),
         failed_reason = null,
         retired_at = case when p_to_state = 'RETIRED' then now() else retired_at end,
         revoked_at = now(),
         api_key_hash = null
   where node_id = p_node_id;

  -- Cancel anything the (now-untrusted) node might still be holding.
  -- provisioning_jobs has no 'cancelled' status (only pending/claimed/
  -- done/failed); 'failed' with a distinguishing result is the closest
  -- fit and matches how a poisoned/expired claim is already reported
  -- elsewhere in this codebase.
  with cancelled as (
    update public.provisioning_jobs
       set status = 'failed',
           result = jsonb_build_object('error', 'node_revoked', 'node_id', p_node_id),
           completed_at = now()
     where node_id = p_node_id
       and status in ('pending', 'claimed')
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  with deleted as (
    delete from public.node_lease_slots where node_id = p_node_id
    returning 1
  )
  select count(*) into v_leases_deleted from deleted;

  delete from public.node_probe_credentials where node_id = p_node_id;

  -- Route directory must stop advertising this node immediately, not only
  -- the next time GET /v1/routes happens to recompute a different payload
  -- hash. Bump unconditionally so the next signed read is guaranteed to be
  -- a new version even if last_payload_hash has not been touched yet.
  update public.route_directory_state set version = version + 1 where id = true;

  return jsonb_build_object(
    'status', 'ok',
    'jobs_cancelled', v_cancelled,
    'lease_slots_deleted', v_leases_deleted
  );
end;
$$;

revoke all on function public.revoke_node_key_and_transition(text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.revoke_node_key_and_transition(text, text, text, boolean)
  to service_role;

-- F-05 admin action: rotate a node's key without changing its lifecycle
-- state (e.g. suspected leak, node still healthy and serving). Old key
-- stops working the instant this commits.
create or replace function public.rotate_node_key(p_node_id text, p_new_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  update public.nodes
     set api_key_hash = p_new_key_hash,
         revoked_at = null
   where node_id = p_node_id
   returning true into v_found;

  if not v_found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.rotate_node_key(text, text) from public, anon, authenticated;
grant execute on function public.rotate_node_key(text, text) to service_role;
