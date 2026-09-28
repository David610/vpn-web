-- F-39 round 2: extends the transactional mutation+audit coupling from
-- 20261008000000_admin_audit_transactional.sql to the remaining
-- highest-value admin mutation routes named by that migration's own scope
-- note (billing/entitlement grants+revokes, credential/subscription
-- rotation job fan-out, and the plain-UPDATE node lifecycle path). Each
-- function below inserts the mutation and its admin_audit_log row in the
-- same Postgres transaction, so a crash or Worker eviction between the two
-- can no longer produce an audited-but-not-applied or applied-but-unaudited
-- state -- either both commit or neither does.
--
-- Still explicitly out of scope (unchanged, same rationale as round 1):
--   - abuse/[id].js and alerts/[id].js (signal triage, not a customer- or
--     fleet-affecting mutation -- lower stakes than the ones covered here).
--   - jobs/[id]/retry.js, nodes/[id]/replace.js (replace.js's mutation is a
--     multi-step saga owned by fleet-operations.js/node lifecycle, not a
--     single-statement candidate for this pattern without touching that
--     saga's own transition logic, which this pass does not touch).
--   - grant.js's/entitlements/[id].js's syncAccountProvisioningToEntitlement
--     call, which stays a separate step after the audited mutation, same
--     as round 1's GoTrue ban/unban call: it fans out over
--     provisioning_jobs rows computed from the *post-grant* effective
--     entitlement (which itself can be influenced by Stripe webhooks
--     landing concurrently), not a fixed set of rows knowable at grant time,
--     so it cannot be pre-computed and handed into the same RPC the way
--     admin_set_account_suspension_with_audit's p_jobs already are.

-- 1. Billing-override / entitlement grant: couples the admin_entitlements
-- insert with its audit row. Returns the new grant row so the caller can
-- keep doing its post-insert getEffectiveEntitlement()/sync work unchanged.
create or replace function public.admin_grant_entitlement_with_audit(
  p_account_id uuid,
  p_expires_at timestamptz,
  p_seat_limit integer,
  p_reason text,
  p_admin_user_id uuid,
  p_audit_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.admin_entitlements;
begin
  insert into public.admin_entitlements (account_id, expires_at, seat_limit, reason, created_by_admin)
  values (p_account_id, p_expires_at, p_seat_limit, p_reason, p_admin_user_id)
  returning * into v_grant;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  values (
    p_admin_user_id,
    'admin.grant_entitlement',
    'customer_account',
    p_account_id::text,
    coalesce(p_audit_metadata, '{}'::jsonb) || jsonb_build_object('grant_id', v_grant.id)
  );

  return jsonb_build_object(
    'id', v_grant.id,
    'account_id', v_grant.account_id,
    'status', v_grant.status,
    'starts_at', v_grant.starts_at,
    'expires_at', v_grant.expires_at,
    'seat_limit', v_grant.seat_limit,
    'reason', v_grant.reason,
    'created_at', v_grant.created_at
  );
end;
$$;

revoke all on function public.admin_grant_entitlement_with_audit(uuid, timestamptz, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_grant_entitlement_with_audit(uuid, timestamptz, integer, text, uuid, jsonb)
  to service_role;

-- 2. Billing-override / entitlement revoke: couples the admin_entitlements
-- status=revoked update with its audit row. Mirrors entitlements/[id].js's
-- existing not-found/duplicate handling so the route's response shape is
-- unchanged.
create or replace function public.admin_revoke_entitlement_with_audit(
  p_grant_id uuid,
  p_admin_user_id uuid,
  p_audit_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.admin_entitlements;
begin
  select * into v_grant from public.admin_entitlements where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_grant.status = 'revoked' then
    return jsonb_build_object('status', 'duplicate', 'account_id', v_grant.account_id);
  end if;

  update public.admin_entitlements
     set status = 'revoked', revoked_at = now()
   where id = p_grant_id;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  values (
    p_admin_user_id,
    'admin.revoke_entitlement',
    'customer_account',
    v_grant.account_id::text,
    coalesce(p_audit_metadata, '{}'::jsonb) || jsonb_build_object('grant_id', p_grant_id)
  );

  return jsonb_build_object('status', 'ok', 'account_id', v_grant.account_id);
end;
$$;

revoke all on function public.admin_revoke_entitlement_with_audit(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_entitlement_with_audit(uuid, uuid, jsonb)
  to service_role;

-- 3. Credential/subscription-token rotation: rotate-credentials.js and
-- rotate.js both fan out a provisioning_jobs insert per vpn_account the
-- user has, then write one audit row -- identical shape apart from
-- job_type/action, so one generic function serves both. p_jobs is an array
-- of { idempotency_key, node_id, vpn_account_id, vpn_user_id } objects
-- built by the caller exactly as it already builds them; this function does
-- not decide which accounts need a job, only inserts the ones it is given
-- (same division of responsibility as admin_set_account_suspension_with_audit).
create or replace function public.admin_insert_jobs_with_audit(
  p_job_type text,
  p_jobs jsonb,
  p_admin_user_id uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_audit_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job jsonb;
  v_job_count integer := 0;
begin
  for v_job in select * from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb))
  loop
    insert into public.provisioning_jobs (idempotency_key, node_id, job_type, vpn_account_id, payload)
    values (
      v_job->>'idempotency_key',
      v_job->>'node_id',
      p_job_type,
      (v_job->>'vpn_account_id')::uuid,
      jsonb_build_object('vpn_user_id', v_job->>'vpn_user_id')
    )
    on conflict (idempotency_key) do nothing;
    v_job_count := v_job_count + 1;
  end loop;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  values (p_admin_user_id, p_action, p_target_type, p_target_id, coalesce(p_audit_metadata, '{}'::jsonb));

  return jsonb_build_object('status', 'ok', 'jobs_enqueued', v_job_count);
end;
$$;

revoke all on function public.admin_insert_jobs_with_audit(text, jsonb, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_insert_jobs_with_audit(text, jsonb, uuid, text, text, text, jsonb)
  to service_role;

-- 4. Node lifecycle: the QUARANTINED/RETIRED path already commits its audit
-- row inside revoke_node_key_and_transition (round 1). Every other
-- transition (e.g. READY -> DRAINING, FAILED -> PROVISIONING) falls through
-- to lifecycle.js's plain optimistic-locked UPDATE, whose audit row was
-- still a separate, best-effort-shaped write after. This closes that gap
-- for the same route, without touching fleet-operations.js's saga logic --
-- p_failed_reason/p_enrollment_token_hash/p_enrollment_token_expires_at are
-- exactly the fields lifecycle.js's `update` object already computes in JS;
-- this function only makes the write and the audit row atomic, not the
-- decision of what to write.
create or replace function public.admin_update_node_lifecycle_with_audit(
  p_node_id text,
  p_to_state text,
  p_expected_from_state text,
  p_failed_reason text,
  p_enrollment_token_hash text,
  p_enrollment_token_expires_at timestamptz,
  p_admin_user_id uuid,
  p_audit_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated_id text;
begin
  update public.nodes
     set lifecycle_state = p_to_state,
         lifecycle_state_changed_at = now(),
         failed_reason = p_failed_reason,
         enrollment_token_hash = coalesce(p_enrollment_token_hash, enrollment_token_hash),
         enrollment_token_expires_at = coalesce(p_enrollment_token_expires_at, enrollment_token_expires_at)
   where node_id = p_node_id
     and lifecycle_state = p_expected_from_state
  returning node_id into v_updated_id;

  if v_updated_id is null then
    return jsonb_build_object('status', 'stale');
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  values (
    p_admin_user_id,
    'admin.node_lifecycle_transition',
    'node',
    p_node_id,
    coalesce(p_audit_metadata, '{}'::jsonb)
      || jsonb_build_object('from', p_expected_from_state, 'to', p_to_state)
  );

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.admin_update_node_lifecycle_with_audit(
  text, text, text, text, text, timestamptz, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.admin_update_node_lifecycle_with_audit(
  text, text, text, text, text, timestamptz, uuid, jsonb
) to service_role;
