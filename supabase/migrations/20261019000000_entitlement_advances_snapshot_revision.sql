-- I-100: a credential's effective entitlement (billing lapse, suspension, device
-- revocation, renewal, grace expiry) changes WITHOUT any write to
-- compatibility_authorizations, so snapshot_revision did not move. The provisioning
-- agent (correctly) refuses a changed snapshot at an unchanged revision, so a
-- renewal after a lapse never re-enabled the credential on the node.
--
-- The snapshot read now records, per node, a digest of the effective entitlement of
-- every credential and advances desired_revision (exactly once, under the node_state
-- row lock) when that digest differs. Revision and rows are produced in one
-- transaction, so a revision never labels rows older than itself. Additive: callers
-- fall back to get_compatibility_authorization_snapshot() when this function is absent.

alter table public.compatibility_authorization_node_state
  add column if not exists entitlement_digest text;

create or replace function public.get_compatibility_authorization_snapshot_synced(p_node_id text)
returns table(snapshot_revision bigint, authorizations jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_digest text;
  v_known  text;
begin
  if exists (select 1 from public.compatibility_authorizations a where a.node_id = p_node_id) then
    select md5(coalesce(string_agg(
             a.credential_id || ':' || case when coalesce(e.entitled, false) then '1' else '0' end,
             ',' order by a.credential_id), ''))
      into v_digest
      from public.compatibility_authorizations a
      left join public.external_vpn_devices d
        on d.principal_id = a.principal_id and d.revoked_at is null
      left join lateral (
        select x.entitled from public.device_entitlement(d.device_id) x limit 1
      ) e on d.device_id is not null
     where a.node_id = p_node_id;

    select s.entitlement_digest into v_known
      from public.compatibility_authorization_node_state s where s.node_id = p_node_id;

    if v_known is distinct from v_digest then
      -- Concurrent callers serialize on the row lock; the loser re-evaluates the
      -- condition against the committed digest and does not bump a second time.
      insert into public.compatibility_authorization_node_state as s
        (node_id, desired_revision, state, requested_at, entitlement_digest)
      values (p_node_id, 1, 'pending', now(), v_digest)
      on conflict (node_id) do update set
        desired_revision = s.desired_revision
          + case when s.entitlement_digest is distinct from excluded.entitlement_digest then 1 else 0 end,
        state = case when s.entitlement_digest is distinct from excluded.entitlement_digest
                     then 'pending' else s.state end,
        requested_at = case when s.entitlement_digest is distinct from excluded.entitlement_digest
                            then now() else s.requested_at end,
        failure_code = case when s.entitlement_digest is distinct from excluded.entitlement_digest
                            then null else s.failure_code end,
        failure_detail = case when s.entitlement_digest is distinct from excluded.entitlement_digest
                              then null else s.failure_detail end,
        entitlement_digest = excluded.entitlement_digest;
    end if;
  end if;

  return query
    select coalesce(s.desired_revision, 0),
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'principal_id', a.principal_id, 'credential_id', a.credential_id,
               'class', a.credential_class, 'valid_from', a.valid_from, 'valid_until', a.valid_until,
               'revoked', a.revoked, 'credential_ciphertext', a.credential_ciphertext,
               'credential_nonce', a.credential_nonce) order by a.credential_id)
               from public.compatibility_authorizations a where a.node_id = p_node_id
           ), '[]'::jsonb)
      from (select 1) seed
      left join public.compatibility_authorization_node_state s on s.node_id = p_node_id;
end $$;

revoke all on function public.get_compatibility_authorization_snapshot_synced(text) from public, anon, authenticated;
grant execute on function public.get_compatibility_authorization_snapshot_synced(text) to service_role;

comment on function public.get_compatibility_authorization_snapshot_synced(text) is
  'Snapshot read that first advances desired_revision once when the node''s effective entitlement digest changed (I-100). Writes only on change.';
