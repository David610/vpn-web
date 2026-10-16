-- Control-plane efficiency for the provisioning agents (Cloudflare quota
-- incident, Sept-Oct 2026). Additive only; safe to apply before or after the
-- application build because every caller falls back when a function is absent.
--
-- 1. device_entitlements_batch: one round trip for N devices instead of N
--    sequential device_entitlement() calls inside /api/agent/authorizations.
-- 2. agent_wake_tokens / agent_entitlement_tokens: tiny, secret-free change
--    fingerprints per node. The VPS-hosted API polls these ONCE per interval
--    for ALL waiting agents (not per agent) and releases long-polling agents
--    when a fingerprint moves. Neither function returns credentials.

create or replace function public.device_entitlements_batch(p_device_ids uuid[])
returns table (device_id uuid, entitled boolean)
language sql
stable
set search_path = ''
as $$
  select d.id,
         coalesce((select e.entitled from public.device_entitlement(d.id) e limit 1), false)
    from unnest(p_device_ids) as d(id);
$$;

revoke all on function public.device_entitlements_batch(uuid[]) from public, anon, authenticated;
grant execute on function public.device_entitlements_batch(uuid[]) to service_role;

comment on function public.device_entitlements_batch(uuid[]) is
  'Batch form of device_entitlement(); unknown devices are reported as not entitled (fail closed).';

create or replace function public.agent_wake_tokens(p_node_ids text[])
returns table (node_id text, jobs_token text, auth_revision bigint, lease_token text)
language sql
stable
set search_path = ''
as $$
  select n.id,
         (select coalesce(max(j.id), 0)::text || ':' || count(*)::text
            from public.provisioning_jobs j
           where j.node_id = n.id and j.status = 'pending'),
         coalesce((select s.desired_revision
                     from public.compatibility_authorization_node_state s
                    where s.node_id = n.id), 0),
         (select md5(coalesce(string_agg(
                   l.slot::text || ':' || l.generation::text || ':' || l.state || ':' ||
                   l.urgent::text || ':' || coalesce(l.extend_to::text, ''), ',' order by l.slot), ''))
            from public.node_lease_slots l
           where l.node_id = n.id and l.state <> 'active')
    from unnest(p_node_ids) as n(id);
$$;

revoke all on function public.agent_wake_tokens(text[]) from public, anon, authenticated;
grant execute on function public.agent_wake_tokens(text[]) to service_role;

comment on function public.agent_wake_tokens(text[]) is
  'Per-node change fingerprints (pending jobs, authorization revision, lease revocations/renewals). No secrets.';

-- Entitlement can flip (billing, suspension) without any row of
-- compatibility_authorizations changing, so it needs its own fingerprint. This
-- is heavier than agent_wake_tokens and is polled on a slower cadence.
create or replace function public.agent_entitlement_tokens(p_node_ids text[])
returns table (node_id text, entitlement_token text)
language sql
stable
set search_path = ''
as $$
  select n.id,
         md5(coalesce((
           select string_agg(a.credential_id || ':' || coalesce(e.entitled::text, 'f'), ',' order by a.credential_id)
             from public.compatibility_authorizations a
             left join public.external_vpn_devices d
               on d.principal_id = a.principal_id and d.revoked_at is null
             left join lateral (
               select x.entitled from public.device_entitlement(d.device_id) x limit 1
             ) e on d.device_id is not null
            where a.node_id = n.id), ''))
    from unnest(p_node_ids) as n(id);
$$;

revoke all on function public.agent_entitlement_tokens(text[]) from public, anon, authenticated;
grant execute on function public.agent_entitlement_tokens(text[]) to service_role;

comment on function public.agent_entitlement_tokens(text[]) is
  'Per-node fingerprint of effective entitlement for its compatibility authorizations. No secrets.';
