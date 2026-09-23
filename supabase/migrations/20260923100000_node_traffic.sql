-- Node traffic accounting.
--
-- The agent reports sing-box's cumulative byte counters on each poll and the
-- server derives deltas. Reporting cumulative rather than deltas is what
-- makes a dropped report harmless: the next one still carries the true
-- total, so the only thing lost is resolution, never bytes.
--
-- SCOPE: these counters are per NODE, not per user. sing-box's per-user
-- statistics live behind its v2ray_api, which is NOT compiled into official
-- sing-box builds (release/DEFAULT_BUILD_TAGS for v1.13.19 lists
-- with_clash_api but not with_v2ray_api, and the binary refuses the config
-- with "v2ray api is not included in this build"). The Clash API that IS
-- available exposes no user attribution at all — a VLESS connection from a
-- named user carries only destination/source/network metadata — and drops
-- closed connections from its list entirely. Per-user accounting therefore
-- needs a custom sing-box build; until that is decided, node totals are the
-- honest ceiling of what can be measured. See docs/TRAFFIC_ACCOUNTING.md.

create table public.node_traffic_samples (
  id bigint generated always as identity primary key,
  node_id text not null references public.nodes (node_id) on delete cascade,

  -- As reported: cumulative since the sing-box process started.
  bytes_up bigint not null check (bytes_up >= 0),
  bytes_down bigint not null check (bytes_down >= 0),
  connections_open integer not null check (connections_open >= 0),

  -- Derived server-side against the previous sample for this node. A
  -- restart resets sing-box's counters, which shows up as a reported total
  -- lower than the previous one; the ingest endpoint treats the new total
  -- as the delta in that case rather than recording a negative.
  delta_up bigint not null check (delta_up >= 0),
  delta_down bigint not null check (delta_down >= 0),
  -- Seconds since the previous sample, so throughput is delta/interval
  -- without having to re-derive it from timestamps at read time. Null on a
  -- node's very first sample, where there is nothing to compare against.
  interval_seconds integer check (interval_seconds > 0),
  counter_reset boolean not null default false,

  sampled_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Every read is "latest sample for a node" or "this node's samples over a
-- window", both served by this one index.
create index node_traffic_samples_node_time_idx
  on public.node_traffic_samples (node_id, sampled_at desc);

alter table public.node_traffic_samples enable row level security;
revoke all on public.node_traffic_samples from anon, authenticated;

-- Daily per-node rollup, so the admin dashboard and any retention policy do
-- not have to scan raw samples. Sums deltas rather than differencing
-- cumulative totals, which keeps restarts from showing up as negative days.
create table public.node_traffic_daily (
  node_id text not null references public.nodes (node_id) on delete cascade,
  day date not null,
  bytes_up bigint not null default 0 check (bytes_up >= 0),
  bytes_down bigint not null default 0 check (bytes_down >= 0),
  sample_count integer not null default 0 check (sample_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (node_id, day)
);

alter table public.node_traffic_daily enable row level security;
revoke all on public.node_traffic_daily from anon, authenticated;

/**
 * Records one sample and folds it into the daily rollup atomically.
 *
 * The delta depends on the previous sample, so two reports for the same node
 * arriving together must not both read the same predecessor and each claim
 * the same bytes. Locking the node row serialises them, which matters
 * because the agent retries on failure and a retry can overlap the original.
 *
 * Returns the derived delta so the caller can report throughput without a
 * second round trip.
 */
create function public.record_node_traffic(
  p_node_id text,
  p_bytes_up bigint,
  p_bytes_down bigint,
  p_connections_open integer,
  p_sampled_at timestamptz
)
returns table (delta_up bigint, delta_down bigint, interval_seconds integer, counter_reset boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev public.node_traffic_samples;
  v_delta_up bigint;
  v_delta_down bigint;
  v_interval integer;
  v_reset boolean := false;
begin
  -- Serialise concurrent reports for this node against each other, and
  -- record liveness in the same pass: a traffic report is as good a sign
  -- the node is alive as a job poll, and the row is already locked here.
  update public.nodes set last_seen_at = now() where node_id = p_node_id;

  select * into v_prev
  from public.node_traffic_samples
  where node_id = p_node_id
  order by sampled_at desc
  limit 1;

  if not found then
    -- First sample for this node. There is no baseline to difference
    -- against, so claim nothing rather than attributing sing-box's entire
    -- lifetime counter to this instant.
    v_delta_up := 0;
    v_delta_down := 0;
    v_interval := null;
  elsif p_bytes_up < v_prev.bytes_up or p_bytes_down < v_prev.bytes_down then
    -- sing-box restarted: counters went backwards. Everything reported now
    -- accumulated since that restart, so the total IS the delta.
    v_reset := true;
    v_delta_up := p_bytes_up;
    v_delta_down := p_bytes_down;
    v_interval := greatest(1, extract(epoch from (p_sampled_at - v_prev.sampled_at))::integer);
  else
    v_delta_up := p_bytes_up - v_prev.bytes_up;
    v_delta_down := p_bytes_down - v_prev.bytes_down;
    v_interval := greatest(1, extract(epoch from (p_sampled_at - v_prev.sampled_at))::integer);
  end if;

  insert into public.node_traffic_samples (
    node_id, bytes_up, bytes_down, connections_open,
    delta_up, delta_down, interval_seconds, counter_reset, sampled_at
  ) values (
    p_node_id, p_bytes_up, p_bytes_down, p_connections_open,
    v_delta_up, v_delta_down, v_interval, v_reset, p_sampled_at
  );

  insert into public.node_traffic_daily (node_id, day, bytes_up, bytes_down, sample_count)
  values (p_node_id, (p_sampled_at at time zone 'UTC')::date, v_delta_up, v_delta_down, 1)
  on conflict (node_id, day) do update set
    bytes_up = public.node_traffic_daily.bytes_up + excluded.bytes_up,
    bytes_down = public.node_traffic_daily.bytes_down + excluded.bytes_down,
    sample_count = public.node_traffic_daily.sample_count + 1,
    updated_at = now();

  return query select v_delta_up, v_delta_down, v_interval, v_reset;
end;
$$;

revoke execute on function public.record_node_traffic(text, bigint, bigint, integer, timestamptz)
  from public, anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;
