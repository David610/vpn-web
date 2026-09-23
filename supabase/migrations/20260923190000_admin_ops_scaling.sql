-- Admin operations scaling: collapse the 30-second overview refresh to one
-- database round trip and add indexes for the global status filters it uses.

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

create index if not exists provisioning_jobs_status_created_idx
  on public.provisioning_jobs (status, created_at desc);

create index if not exists vpn_accounts_enabled_idx
  on public.vpn_accounts (enabled);

create index if not exists member_invites_live_expires_idx
  on public.member_invites (expires_at)
  where accepted_at is null and revoked_at is null;

create or replace function public.admin_overview_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  subscription_metrics as (
    select
      count(*) filter (where s.status = 'active')::bigint as active,
      count(*) filter (where s.status = 'trialing')::bigint as trialing,
      count(*) filter (where s.status = 'past_due')::bigint as past_due,
      count(*) filter (where s.status = 'canceled')::bigint as canceled,
      coalesce(sum(s.extra_seats) filter (
        where s.status in ('trialing', 'active', 'past_due')
      ), 0)::bigint as paid_extra_seats
    from public.subscriptions s
  ),
  vpn_metrics as (
    select
      count(*)::bigint as accounts,
      count(*) filter (where v.enabled)::bigint as enabled,
      count(*) filter (where not v.enabled)::bigint as disabled
    from public.vpn_accounts v
  ),
  job_metrics as (
    select
      count(*) filter (where j.status = 'pending')::bigint as pending,
      count(*) filter (where j.status = 'claimed')::bigint as claimed,
      count(*) filter (where j.status = 'failed')::bigint as failed
    from public.provisioning_jobs j
  ),
  node_metrics as (
    select
      count(*) filter (
        where n.revoked_at is null
          and n.last_seen_at is not null
          and n.last_seen_at > now() - interval '90 seconds'
      )::bigint as online,
      count(*) filter (where n.revoked_at is null)::bigint as non_revoked
    from public.nodes n
  ),
  latest_node_traffic as (
    select distinct on (s.node_id)
      s.node_id,
      s.delta_up,
      s.delta_down,
      s.interval_seconds,
      s.sampled_at
    from public.node_traffic_samples s
    order by s.node_id, s.sampled_at desc
  ),
  traffic_now as (
    select
      coalesce(sum(
        case
          when t.sampled_at > now() - interval '120 seconds'
            and t.interval_seconds > 0
          then round((coalesce(t.delta_down, 0)::numeric * 8) / t.interval_seconds)
          else 0
        end
      ), 0)::bigint as download_bps,
      coalesce(sum(
        case
          when t.sampled_at > now() - interval '120 seconds'
            and t.interval_seconds > 0
          then round((coalesce(t.delta_up, 0)::numeric * 8) / t.interval_seconds)
          else 0
        end
      ), 0)::bigint as upload_bps
    from latest_node_traffic t
  ),
  traffic_month as (
    select
      coalesce(sum(d.bytes_down), 0)::bigint as download_bytes,
      coalesce(sum(d.bytes_up), 0)::bigint as upload_bytes
    from public.node_traffic_daily d
    where d.day >= date_trunc('month', now())::date
  )
  select jsonb_build_object(
    'customers', jsonb_build_object(
      'total', (select count(*)::bigint from public.customer_accounts),
      'active', sm.active,
      'trialing', sm.trialing,
      'past_due', sm.past_due,
      'canceled', sm.canceled
    ),
    'members', jsonb_build_object(
      'active', (select count(*)::bigint from public.account_members),
      'pending_invites', (
        select count(*)::bigint
        from public.member_invites i
        where i.accepted_at is null
          and i.revoked_at is null
          and i.expires_at > now()
      ),
      'admin_grants', (
        select count(*)::bigint
        from public.admin_entitlements e
        where e.status = 'active'
          and e.starts_at <= now()
          and (e.expires_at is null or e.expires_at > now())
      ),
      'paid_extra_seats', sm.paid_extra_seats
    ),
    'vpn', jsonb_build_object(
      'accounts', vm.accounts,
      'enabled', vm.enabled,
      'disabled', vm.disabled
    ),
    'jobs', jsonb_build_object(
      'pending', jm.pending,
      'claimed', jm.claimed,
      'failed', jm.failed
    ),
    'nodes', jsonb_build_object(
      'online', nm.online,
      'offline', greatest(nm.non_revoked - nm.online, 0)
    ),
    'usage', jsonb_build_object(
      'download_bps', tn.download_bps,
      'upload_bps', tn.upload_bps,
      'month_download_bytes', tm.download_bytes,
      'month_upload_bytes', tm.upload_bytes,
      'month_total_bytes', tm.download_bytes + tm.upload_bytes
    ),
    'alerts', jsonb_build_object(
      'open', (
        select count(*)::bigint
        from public.operational_alerts a
        where a.status = 'open'
      )
    ),
    'abuse', jsonb_build_object(
      'open', (
        select count(*)::bigint
        from public.abuse_signals a
        where a.review_status = 'open'
          and a.flagged = true
      )
    )
  )
  from subscription_metrics sm
  cross join vpn_metrics vm
  cross join job_metrics jm
  cross join node_metrics nm
  cross join traffic_now tn
  cross join traffic_month tm;
$$;

revoke all on function public.admin_overview_snapshot()
  from public, anon, authenticated;
grant execute on function public.admin_overview_snapshot()
  to service_role;
