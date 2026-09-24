-- Canonical device VPN identities (fleet integration).
--
-- A vpn_accounts row is now "the VPN identity of ONE device on ONE node":
-- its own vpn_user_id and credentials, never shared with another device.
-- Until now the table was unique per (user_id, node_id), which made a
-- second device of the same person on the same node impossible and tied
-- revocation to people instead of devices.
--
-- 1. Link any identity created since fleet_foundations' backfill (CREATE_USER
--    completions did not record a device yet) to a device of its user, so
--    every identity of a current account member has a device.
-- 2. Uniqueness moves to (device_id, node_id). Rows whose user has left every
--    account keep device_id null and stay unique per (user_id, node_id).
-- 3. devices record where the scheduler placed them (or why it could not --
--    the fail-closed outcome must be visible, not a silent absence) and
--    when they were revoked.

do $$
declare
  r record;
  v_device_id uuid;
begin
  for r in
    select va.id as vpn_account_id, va.user_id, va.created_at, m.account_id
    from public.vpn_accounts va
    join public.account_members m on m.user_id = va.user_id
    where va.device_id is null
  loop
    select d.id into v_device_id
    from public.devices d
    where d.user_id = r.user_id
      and d.account_id = r.account_id
      and not exists (select 1 from public.vpn_accounts x where x.device_id = d.id)
    order by d.created_at
    limit 1;

    if v_device_id is null then
      insert into public.devices (account_id, user_id, name, status, created_at)
      values (r.account_id, r.user_id, 'Legacy device', 'ACTIVE', r.created_at)
      returning id into v_device_id;
    end if;

    update public.vpn_accounts set device_id = v_device_id where id = r.vpn_account_id;
  end loop;
end $$;

drop index if exists public.vpn_accounts_user_node_uniq;

alter table public.vpn_accounts
  add constraint vpn_accounts_device_node_uniq unique (device_id, node_id);

create unique index vpn_accounts_unlinked_user_node_uniq
  on public.vpn_accounts (user_id, node_id)
  where device_id is null;

alter table public.devices
  add column placement_status text not null default 'PENDING'
    check (placement_status in ('PENDING', 'PLACED', 'UNSCHEDULABLE')),
  add column placement_error text check (char_length(placement_error) <= 300),
  add column placement_updated_at timestamptz,
  add column revoked_at timestamptz;

update public.devices d
   set placement_status = 'PLACED', placement_updated_at = now()
 where exists (select 1 from public.vpn_accounts va where va.device_id = d.id);

update public.devices set revoked_at = now() where status = 'REVOKED' and revoked_at is null;

-- Jobs record which device they act for, and the database -- not a
-- read-then-write check in application code -- guarantees at most ONE
-- in-flight CREATE_USER per (device, node). Two overlapping reconciles (a
-- Stripe webhook and a device change, say) would otherwise both enqueue a
-- create, producing two node users for one device and orphaning one of them
-- as a live, untracked credential. A racing insert now fails with 23505,
-- which callers already treat as "already enqueued".
alter table public.provisioning_jobs
  add column device_id uuid references public.devices (id) on delete set null;

create index provisioning_jobs_device_id_idx on public.provisioning_jobs (device_id);

create unique index provisioning_jobs_one_inflight_create_per_device_node
  on public.provisioning_jobs (device_id, node_id)
  where job_type = 'CREATE_USER' and status in ('pending', 'claimed') and device_id is not null;
