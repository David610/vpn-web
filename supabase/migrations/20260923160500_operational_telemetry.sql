-- Operational telemetry with privacy-preserving, aggregate-only data.
-- No destination IPs/domains/URLs are stored.

alter table public.nodes
  add column agent_version text,
  add column vpn_version text,
  add column singbox_version text,
  add column uptime_seconds bigint,
  add column cpu_percent double precision,
  add column memory_percent double precision,
  add column disk_percent double precision,
  add column network_rx_bps bigint,
  add column network_tx_bps bigint,
  add column configured_users integer,
  add column active_users_recent integer,
  add column telemetry_at timestamptz;

create table public.vpn_usage_current (
  vpn_account_id bigint primary key references public.vpn_accounts (id) on delete cascade,
  sampled_at timestamptz not null,
  download_bytes_total bigint not null check (download_bytes_total >= 0),
  upload_bytes_total bigint not null check (upload_bytes_total >= 0),
  download_bps bigint not null default 0 check (download_bps >= 0),
  upload_bps bigint not null default 0 check (upload_bps >= 0),
  last_seen_at timestamptz
);

create table public.vpn_usage_hourly (
  vpn_account_id bigint not null references public.vpn_accounts (id) on delete cascade,
  hour timestamptz not null,
  download_bytes bigint not null default 0 check (download_bytes >= 0),
  upload_bytes bigint not null default 0 check (upload_bytes >= 0),
  primary key (vpn_account_id, hour)
);

create index vpn_usage_hourly_hour_idx on public.vpn_usage_hourly (hour);

alter table public.vpn_usage_current enable row level security;
alter table public.vpn_usage_hourly enable row level security;
revoke all on public.vpn_usage_current, public.vpn_usage_hourly from anon, authenticated;

-- Atomically turn monotonically increasing (but restart-resettable) counters
-- into non-negative deltas, live bit-rates and hourly rollups. Out-of-order
-- and duplicate samples are ignored.
create function public.record_vpn_usage_sample(
  p_vpn_account_id bigint,
  p_sampled_at timestamptz,
  p_download_bytes_total bigint,
  p_upload_bytes_total bigint,
  p_last_seen_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev public.vpn_usage_current;
  v_down_delta bigint := 0;
  v_up_delta bigint := 0;
  v_elapsed double precision := 0;
  v_down_bps bigint := 0;
  v_up_bps bigint := 0;
  v_hour timestamptz := date_trunc('hour', p_sampled_at);
begin
  if p_download_bytes_total < 0 or p_upload_bytes_total < 0 then
    raise exception 'negative_counter';
  end if;

  select * into v_prev
  from public.vpn_usage_current
  where vpn_account_id = p_vpn_account_id
  for update;

  if found and p_sampled_at <= v_prev.sampled_at then
    return;
  end if;

  if found then
    v_elapsed := extract(epoch from (p_sampled_at - v_prev.sampled_at));
    v_down_delta := case
      when p_download_bytes_total >= v_prev.download_bytes_total
        then p_download_bytes_total - v_prev.download_bytes_total
      else p_download_bytes_total
    end;
    v_up_delta := case
      when p_upload_bytes_total >= v_prev.upload_bytes_total
        then p_upload_bytes_total - v_prev.upload_bytes_total
      else p_upload_bytes_total
    end;

    if v_elapsed > 0 then
      v_down_bps := floor((v_down_delta::numeric * 8) / v_elapsed)::bigint;
      v_up_bps := floor((v_up_delta::numeric * 8) / v_elapsed)::bigint;
    end if;
  end if;

  insert into public.vpn_usage_current (
    vpn_account_id, sampled_at, download_bytes_total, upload_bytes_total,
    download_bps, upload_bps, last_seen_at
  )
  values (
    p_vpn_account_id, p_sampled_at, p_download_bytes_total, p_upload_bytes_total,
    greatest(v_down_bps, 0), greatest(v_up_bps, 0), p_last_seen_at
  )
  on conflict (vpn_account_id) do update set
    sampled_at = excluded.sampled_at,
    download_bytes_total = excluded.download_bytes_total,
    upload_bytes_total = excluded.upload_bytes_total,
    download_bps = excluded.download_bps,
    upload_bps = excluded.upload_bps,
    last_seen_at = coalesce(excluded.last_seen_at, public.vpn_usage_current.last_seen_at);

  if v_down_delta > 0 or v_up_delta > 0 then
    insert into public.vpn_usage_hourly (
      vpn_account_id, hour, download_bytes, upload_bytes
    )
    values (p_vpn_account_id, v_hour, v_down_delta, v_up_delta)
    on conflict (vpn_account_id, hour) do update set
      download_bytes = public.vpn_usage_hourly.download_bytes + excluded.download_bytes,
      upload_bytes = public.vpn_usage_hourly.upload_bytes + excluded.upload_bytes;
  end if;
end;
$$;

revoke execute on function public.record_vpn_usage_sample(bigint, timestamptz, bigint, bigint, timestamptz)
  from public, anon, authenticated;

create table public.operational_alerts (
  id bigint generated always as identity primary key,
  alert_type text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  dedup_key text,
  node_id text,
  vpn_account_id bigint references public.vpn_accounts (id) on delete set null,
  message text not null check (char_length(message) <= 1000),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index operational_alerts_open_dedup_uniq
  on public.operational_alerts (dedup_key)
  where status = 'open' and dedup_key is not null;

create index operational_alerts_status_created_idx
  on public.operational_alerts (status, created_at desc);

alter table public.operational_alerts enable row level security;
revoke all on public.operational_alerts from anon, authenticated;

alter table public.abuse_signals
  add column review_status text not null default 'open'
    check (review_status in ('open', 'reviewed', 'ignored')),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users (id);

create index abuse_signals_review_status_idx
  on public.abuse_signals (review_status, created_at desc);

revoke all on all sequences in schema public from anon, authenticated;
