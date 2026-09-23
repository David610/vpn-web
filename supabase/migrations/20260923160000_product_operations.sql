-- Product operations added after the account/seat migration:
-- trial reservation state, support entitlements, encrypted first-party
-- provisioning URLs, node telemetry, privacy-preserving usage rollups,
-- alerts, and abuse-review state.

-- ------------------------------------------------------------
-- One-time trial reservation/consumption state.
-- ------------------------------------------------------------
alter table public.customer_accounts
  add column trial_reserved_at timestamptz,
  add column trial_used_at timestamptz;

create function public.reserve_free_trial(p_account_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.customer_accounts;
  v_now timestamptz := now();
begin
  select * into v_account
  from public.customer_accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'account_not_found';
  end if;

  if v_account.trial_used_at is not null then
    return null;
  end if;

  -- A crashed/abandoned Checkout must not reserve the trial forever.
  if v_account.trial_reserved_at is not null
     and v_account.trial_reserved_at > v_now - interval '24 hours' then
    return null;
  end if;

  update public.customer_accounts
  set trial_reserved_at = v_now
  where id = p_account_id;

  return v_now;
end;
$$;

revoke execute on function public.reserve_free_trial(uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- Admin-granted access. This is deliberately separate from Stripe:
-- it grants service but never pretends that revenue was collected.
-- One unrevoked support grant per account keeps precedence simple.
-- ------------------------------------------------------------
create table public.admin_entitlements (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.customer_accounts (id) on delete cascade,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  seat_limit integer not null default 3 check (seat_limit between 1 and 100),
  reason text not null check (length(trim(reason)) between 3 and 500),
  created_by_admin uuid not null references auth.users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);

create unique index admin_entitlements_one_live_per_account
  on public.admin_entitlements (account_id)
  where revoked_at is null;

create index admin_entitlements_account_idx
  on public.admin_entitlements (account_id, created_at desc);

create trigger admin_entitlements_set_updated_at
  before update on public.admin_entitlements
  for each row execute function public.set_updated_at();

alter table public.admin_entitlements enable row level security;
revoke all on public.admin_entitlements from anon, authenticated;

-- ------------------------------------------------------------
-- A vpn_secrets row remains one rotation/version of the user's access
-- URLs. Legacy rows have only subscription_url material; newer rows may
-- additionally carry the first-party /v1/provision URL encrypted under
-- the same external AES-GCM key.
-- ------------------------------------------------------------
alter table public.vpn_secrets
  add column provisioning_ciphertext bytea,
  add column provisioning_nonce bytea
    check (provisioning_nonce is null or octet_length(provisioning_nonce) = 12),
  add constraint vpn_secrets_provisioning_pair_check check (
    (provisioning_ciphertext is null and provisioning_nonce is null)
    or
    (provisioning_ciphertext is not null and provisioning_nonce is not null)
  );

-- ------------------------------------------------------------
-- Support grants with no expiry require clearing a previously-set
-- vpn-admin expiry. The CLI already supports clear-expiry; expose it as
-- an explicit job instead of inventing a far-future timestamp.
-- ------------------------------------------------------------
alter table public.provisioning_jobs
  drop constraint provisioning_jobs_job_type_check;

alter table public.provisioning_jobs
  add constraint provisioning_jobs_job_type_check check (
    job_type in (
      'CREATE_USER',
      'SET_EXPIRY',
      'CLEAR_EXPIRY',
      'ENABLE_USER',
      'DISABLE_USER',
      'ROTATE_SUBSCRIPTION_TOKEN'
    )
  );

-- ------------------------------------------------------------
-- Node heartbeat snapshot. This is operational data only.
-- ------------------------------------------------------------
alter table public.nodes
  add column agent_version text,
  add column vpn_version text,
  add column singbox_version text,
  add column uptime_seconds bigint check (uptime_seconds is null or uptime_seconds >= 0),
  add column cpu_percent double precision check (cpu_percent is null or (cpu_percent >= 0 and cpu_percent <= 100)),
  add column memory_percent double precision check (memory_percent is null or (memory_percent >= 0 and memory_percent <= 100)),
  add column disk_percent double precision check (disk_percent is null or (disk_percent >= 0 and disk_percent <= 100)),
  add column network_rx_bps bigint check (network_rx_bps is null or network_rx_bps >= 0),
  add column network_tx_bps bigint check (network_tx_bps is null or network_tx_bps >= 0),
  add column configured_users integer check (configured_users is null or configured_users >= 0),
  add column active_users_recent integer check (active_users_recent is null or active_users_recent >= 0),
  add column metrics_sampled_at timestamptz;

-- ------------------------------------------------------------
-- Per-VPN-account traffic aggregates. No destinations, domains, DNS
-- history or connection metadata are stored.
-- ------------------------------------------------------------
create table public.vpn_usage_current (
  vpn_account_id bigint primary key references public.vpn_accounts (id) on delete cascade,
  sampled_at timestamptz not null,
  download_bps bigint not null default 0 check (download_bps >= 0),
  upload_bps bigint not null default 0 check (upload_bps >= 0),
  download_bytes_total bigint not null default 0 check (download_bytes_total >= 0),
  upload_bytes_total bigint not null default 0 check (upload_bytes_total >= 0),
  last_active_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger vpn_usage_current_set_updated_at
  before update on public.vpn_usage_current
  for each row execute function public.set_updated_at();

create table public.vpn_usage_hourly (
  id bigint generated always as identity primary key,
  vpn_account_id bigint not null references public.vpn_accounts (id) on delete cascade,
  hour timestamptz not null,
  download_bytes bigint not null default 0 check (download_bytes >= 0),
  upload_bytes bigint not null default 0 check (upload_bytes >= 0),
  created_at timestamptz not null default now(),
  unique (vpn_account_id, hour)
);

create index vpn_usage_hourly_account_hour_idx
  on public.vpn_usage_hourly (vpn_account_id, hour desc);

alter table public.vpn_usage_current enable row level security;
alter table public.vpn_usage_hourly enable row level security;
revoke all on public.vpn_usage_current, public.vpn_usage_hourly from anon, authenticated;

-- ------------------------------------------------------------
-- Actionable admin alerts with one currently-open row per dedupe key.
-- ------------------------------------------------------------
create table public.admin_alerts (
  id bigint generated always as identity primary key,
  alert_type text not null,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  dedupe_key text not null,
  message text not null,
  node_id text,
  vpn_account_id bigint references public.vpn_accounts (id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id)
);

create unique index admin_alerts_open_dedupe_uniq
  on public.admin_alerts (dedupe_key)
  where resolved_at is null;
create index admin_alerts_open_idx
  on public.admin_alerts (severity, last_seen_at desc)
  where resolved_at is null;

alter table public.admin_alerts enable row level security;
revoke all on public.admin_alerts from anon, authenticated;

-- ------------------------------------------------------------
-- Manual abuse review state. Existing signal generation stays soft;
-- there is still no automatic ban.
-- ------------------------------------------------------------
alter table public.abuse_signals
  add column review_status text not null default 'open'
    check (review_status in ('open', 'reviewed', 'ignored')),
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users (id);

revoke all on all sequences in schema public from anon, authenticated;
