-- Fleet backup/restore drill verification (Fleet Platform Plan Phase 14).
--
-- Run this against a RESTORED database (a Supabase point-in-time-recovery
-- target, or a restored logical backup) before promoting it or declaring a
-- restore drill successful:
--
--   psql "$RESTORED_DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify-fleet-backup-restore.sql
--
-- This does not restore anything itself -- that's a Supabase
-- dashboard/CLI action (Database -> Backups -> restore to a new project,
-- or `supabase db dump` / `pg_restore` for a self-managed target). This
-- script only asserts the *result* is trustworthy: schema completeness
-- (did every migration actually apply, not just the ones before some
-- cutoff), referential integrity (did the restore silently drop rows a
-- foreign key should have prevented dropping), and non-empty core tables
-- (did this restore actually land at a point with real data, not an
-- empty pre-launch snapshot by mistake).
--
-- Every check RAISEs on failure (aborts immediately, non-zero exit via
-- ON_ERROR_STOP) rather than printing a warning and continuing -- a drill
-- whose failure mode is "read past a scary-looking NOTICE" is not a drill
-- anyone will actually stop and act on.

do $$
declare
  v_count bigint;
begin
  -- ---- schema completeness -------------------------------------------------
  -- lifecycle_state_changed_at (Phase 12a) and the CANARY state (Phase 12b)
  -- are two of the most recent schema changes this fleet work shipped; their
  -- presence is a reasonable proxy for "every migration up to the current
  -- head actually applied to this restore," not just an early subset.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'nodes' and column_name = 'lifecycle_state_changed_at'
  ) then
    raise exception 'nodes.lifecycle_state_changed_at is missing -- this restore predates Phase 12a''s migration';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nodes_lifecycle_state_check'
      and pg_get_constraintdef(oid) like '%CANARY%'
  ) then
    raise exception 'nodes_lifecycle_state_check does not allow CANARY -- this restore predates Phase 12b''s migration';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'fleet_operations'
  ) then
    raise exception 'public.fleet_operations is missing -- this restore predates Phase 1''s fleet foundations migration';
  end if;

  -- ---- referential integrity ------------------------------------------------
  -- These relationships are enforced by foreign keys today; a restore that
  -- somehow landed rows violating them (a corrupted dump, a restore mid-
  -- migration, manual intervention on the source before backup) must be
  -- caught here rather than surfacing later as a 500 in production.
  select count(*) into v_count
  from public.devices d
  where not exists (select 1 from public.customer_accounts a where a.id = d.account_id);
  if v_count > 0 then
    raise exception '% device(s) reference a customer_accounts row that does not exist', v_count;
  end if;

  select count(*) into v_count
  from public.vpn_accounts v
  where v.device_id is not null
    and not exists (select 1 from public.devices d where d.id = v.device_id);
  if v_count > 0 then
    raise exception '% vpn_accounts row(s) reference a device that does not exist', v_count;
  end if;

  select count(*) into v_count
  from public.device_profile_assignments dpa
  where not exists (select 1 from public.devices d where d.id = dpa.device_id)
     or not exists (select 1 from public.connection_profiles p where p.id = dpa.profile_id);
  if v_count > 0 then
    raise exception '% device_profile_assignments row(s) reference a missing device or profile', v_count;
  end if;

  select count(*) into v_count
  from public.fleet_operations op
  where op.node_id is not null
    and not exists (select 1 from public.nodes n where n.node_id = op.node_id);
  if v_count > 0 then
    raise exception '% fleet_operations row(s) reference a node that does not exist', v_count;
  end if;

  select count(*) into v_count
  from public.operation_steps s
  where not exists (select 1 from public.fleet_operations op where op.id = s.operation_id);
  if v_count > 0 then
    raise exception '% operation_steps row(s) reference an operation that does not exist', v_count;
  end if;

  select count(*) into v_count
  from public.nodes n
  where not exists (select 1 from public.locations l where l.id = n.location_id);
  if v_count > 0 then
    raise exception '% node(s) reference a location that does not exist', v_count;
  end if;

  -- ---- lifecycle state validity ---------------------------------------------
  select count(*) into v_count
  from public.nodes
  where lifecycle_state is null;
  if v_count > 0 then
    raise exception '% node(s) have a null lifecycle_state', v_count;
  end if;

  -- ---- non-empty core tables -------------------------------------------------
  -- Not a correctness check (an empty table can be legitimate pre-launch),
  -- but a restore of a production-shaped database landing at zero rows here
  -- usually means the wrong restore point or project was picked, so it is
  -- worth a loud NOTICE even though it does not abort the script.
  select count(*) into v_count from public.customer_accounts;
  if v_count = 0 then
    raise notice 'customer_accounts is empty -- confirm this is the intended restore point, not an empty/pre-launch snapshot';
  end if;

  select count(*) into v_count from public.nodes;
  if v_count = 0 then
    raise notice 'nodes is empty -- confirm this is the intended restore point';
  end if;

  raise notice 'fleet backup/restore verification passed';
end $$;
