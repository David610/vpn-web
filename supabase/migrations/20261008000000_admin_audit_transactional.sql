-- F-39: admin audit log best-effort/mutable. writeAdminAudit (functions/lib
-- /admin-audit.js) was hardened in round 1 to throw on an insert failure,
-- but it still runs as a second, separate statement after the mutation it
-- records -- a crash (or a Worker eviction) between the two loses the audit
-- trail for a real mutation. This migration closes that gap for the two
-- highest-value admin mutation families by moving the mutation + the audit
-- insert into a single Postgres transaction:
--
--   1. revoke_node_key_and_transition (F-05/C-09, 20261002000000) already
--      does the QUARANTINED/RETIRED node transition atomically; it is
--      extended here (new optional p_admin_user_id/p_audit_metadata
--      parameters, backward compatible -- omitting them keeps the old
--      no-audit behaviour) to also insert the admin_audit_log row in the
--      same transaction.
--   2. admin_set_account_suspension_with_audit is new: it couples
--      customer_accounts.suspended_at (F-07/C-06, the account-wide suspend
--      flag device_entitlement() honors) with the DISABLE_USER/ENABLE_USER
--      provisioning_jobs inserts and the admin_audit_log row, all in one
--      transaction. The Supabase Auth ban/unban call in disable.js/enable.js
--      stays outside this RPC on purpose -- GoTrue's admin API is not a
--      Postgres statement and cannot join this transaction; coupling it
--      would need a saga/compensation pattern like account-deletion's
--      (fleet-tick.js resuming an interrupted saga), which is a larger
--      change than this pass's remaining budget covers. That residual gap
--      (a crash between this RPC committing and the ban call) is smaller
--      than before -- the suspend, the job rows, and the audit trail can no
--      longer diverge from each other -- and is documented as follow-up
--      work, not silently left unmentioned.
--
-- The other ~10 admin mutation call sites named by the audit's F-39 section
-- (grants, rotate-credentials, device rename/remove, etc.) are unchanged by
-- this migration and remain on the writeAdminAudit-throws-on-failure
-- behaviour from round 1 -- explicitly scoped out of this pass, see the
-- remediation report.

create or replace function public.revoke_node_key_and_transition(
  p_node_id text,
  p_to_state text,
  p_expected_from_state text,
  p_override_dns_check boolean default false,
  p_admin_user_id uuid default null,
  p_audit_metadata jsonb default null
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

  if v_node.lifecycle_state <> p_expected_from_state then
    return jsonb_build_object('status', 'stale', 'lifecycle_state', v_node.lifecycle_state);
  end if;

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

  update public.route_directory_state set version = version + 1 where id = true;

  -- F-39: same transaction as every write above -- a crash here rolls back
  -- the whole thing, not just the audit row. NULL p_admin_user_id (an old
  -- caller that hasn't been updated, or a test) skips the insert entirely
  -- rather than inserting a row with no admin attributed to it.
  if p_admin_user_id is not null then
    insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
    values (
      p_admin_user_id,
      'admin.node_lifecycle_transition',
      'node',
      p_node_id,
      coalesce(p_audit_metadata, '{}'::jsonb)
        || jsonb_build_object(
             'from', p_expected_from_state,
             'to', p_to_state,
             'key_revoked', true,
             'jobs_cancelled', v_cancelled,
             'lease_slots_deleted', v_leases_deleted
           )
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'jobs_cancelled', v_cancelled,
    'lease_slots_deleted', v_leases_deleted
  );
end;
$$;

revoke all on function public.revoke_node_key_and_transition(text, text, text, boolean, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.revoke_node_key_and_transition(text, text, text, boolean, uuid, jsonb)
  to service_role;

-- F-07/F-39: couples the account-wide suspend/unsuspend flag with its
-- DISABLE_USER/ENABLE_USER provisioning_jobs fan-out and the audit row.
-- p_jobs is an array of { node_id, vpn_account_id, vpn_user_id,
-- idempotency_key } objects, built by the caller exactly as disable.js/
-- enable.js already build them (one per enabled/disabled vpn_accounts row) --
-- this function does not decide which accounts need a job, only inserts the
-- ones it is given, so device_entitlement()'s and getAccountVpnAccounts()'s
-- existing selection logic in JS is untouched.
create or replace function public.admin_set_account_suspension_with_audit(
  p_account_id uuid,
  p_suspended boolean,
  p_jobs jsonb,
  p_admin_user_id uuid,
  p_action text,
  p_audit_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
  v_job jsonb;
  v_job_count integer := 0;
begin
  if p_action not in ('admin.disable_account', 'admin.enable_account') then
    raise exception 'admin_set_account_suspension_with_audit: unexpected action %', p_action;
  end if;

  update public.customer_accounts
     set suspended_at = case when p_suspended then now() else null end
   where id = p_account_id
  returning true into v_found;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  for v_job in select * from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb))
  loop
    insert into public.provisioning_jobs (idempotency_key, node_id, job_type, vpn_account_id, payload)
    values (
      v_job->>'idempotency_key',
      v_job->>'node_id',
      case when p_suspended then 'DISABLE_USER' else 'ENABLE_USER' end,
      (v_job->>'vpn_account_id')::uuid,
      jsonb_build_object('vpn_user_id', v_job->>'vpn_user_id')
    )
    on conflict (idempotency_key) do nothing;
    v_job_count := v_job_count + 1;
  end loop;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, metadata)
  values (p_admin_user_id, p_action, 'customer_account', p_account_id::text, p_audit_metadata);

  return jsonb_build_object('status', 'ok', 'jobs_enqueued', v_job_count);
end;
$$;

revoke all on function public.admin_set_account_suspension_with_audit(uuid, boolean, jsonb, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_set_account_suspension_with_audit(uuid, boolean, jsonb, uuid, text, jsonb)
  to service_role;
