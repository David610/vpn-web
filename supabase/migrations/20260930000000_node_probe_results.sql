-- Phase 4 protocol-level fleet health. Agents run real REALITY/Hysteria2
-- handshakes (local sing-box client) against peers and themselves and
-- report per-dimension results on their heartbeat; see
-- functions/lib/protocol-health.js for which of these feed lifecycle
-- decisions (only useful-egress streaks) and which are informational.
-- Additive only -- see docs/ADR/0001 precedent.

create table if not exists public.node_probe_results (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  reporter_node_id text not null,
  target_node_id text not null,
  vantage text not null check (vantage in ('peer', 'self')),
  protocol text not null check (protocol in ('reality', 'hysteria2')),
  dimension text not null check (dimension in (
    'useful_egress', 'tcp_connect', 'handshake', 'https_ipv4', 'dns',
    'ipv6', 'egress_ip', 'latency', 'loss')),
  ok boolean,
  value_num bigint,
  value_text text check (value_text is null or length(value_text) <= 64)
);
create index if not exists node_probe_results_target_time
  on public.node_probe_results (target_node_id, observed_at desc);
alter table public.node_probe_results enable row level security;
-- No policies: service role only (Worker endpoints).

-- Bounded retention, called by the Worker after each insert for a target:
-- drops rows older than p_keep_hours and anything beyond the newest
-- p_max_rows for that target.
create or replace function public.prune_node_probe_results(
  p_target_node_id text, p_keep_hours integer, p_max_rows integer)
returns void
language sql
security definer
set search_path = public
as $$
  delete from node_probe_results
   where target_node_id = p_target_node_id
     and observed_at < now() - make_interval(hours => greatest(p_keep_hours, 1));
  delete from node_probe_results
   where target_node_id = p_target_node_id
     and id < coalesce((
       select id from node_probe_results
        where target_node_id = p_target_node_id
        order by id desc offset greatest(p_max_rows, 1) - 1 limit 1), 0);
$$;
revoke all on function public.prune_node_probe_results(text, integer, integer) from public, anon, authenticated;
grant execute on function public.prune_node_probe_results(text, integer, integer) to service_role;

-- Each node's reserved, non-customer probe credential (share links of its
-- `arcana-probe` user), published by the node itself and handed only to
-- other authenticated agents. Grants proxy egress on that one node; tied
-- to no customer, device, subscription or traffic record.
create table if not exists public.node_probe_credentials (
  node_id text primary key,
  reality_uri text check (reality_uri is null or length(reality_uri) <= 2048),
  hysteria2_uri text check (hysteria2_uri is null or length(hysteria2_uri) <= 2048),
  updated_at timestamptz not null default now()
);
alter table public.node_probe_credentials enable row level security;
-- No policies: service role only. Never returned by any admin endpoint.

alter table nodes
  add column if not exists protocol_health jsonb,
  add column if not exists protocol_health_at timestamptz,
  add column if not exists protocol_probe_failures int not null default 0,
  add column if not exists protocol_probe_successes int not null default 0,
  add column if not exists last_peer_probe_at timestamptz,
  add column if not exists hysteria2_cert_days int,
  -- IP reputation is deliberately NOT health: informational only, never
  -- read by any lifecycle decision and never a path into FAILED.
  add column if not exists ip_reputation text,
  add column if not exists ip_reputation_checked_at timestamptz;
