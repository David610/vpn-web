-- Fleet platform Phase 7: double-hop scheduling needs to remember TWO
-- sticky node assignments per device (a RELAY hop and an EXIT hop), not
-- one. device_node_assignments (Phase 5, 20260924030000) was built with
-- device_id as a single-row primary key for the DIRECT-only scheduler --
-- functions/lib/scheduler.js's scheduleNodeForDevice() -- which never
-- needed more than one node per device.
--
-- This migration is additive in effect (no data loss, no behavior change
-- for existing DIRECT rows) even though it alters the table shape: it adds
-- a `hop` column, defaults every existing row to 'EXIT' (the only hop kind
-- that existed before this phase), and widens the primary key to
-- (device_id, hop) so a double-hop device can hold both a RELAY row and an
-- EXIT row simultaneously. scheduleNodeForDevice()'s own upsert is updated
-- in the same phase to write hop = 'EXIT' explicitly and conflict on
-- (device_id, hop), so its behavior for existing DIRECT devices is
-- unchanged: still exactly one EXIT row per device.
alter table public.device_node_assignments
  add column hop text not null default 'EXIT' check (hop in ('RELAY', 'EXIT'));

alter table public.device_node_assignments
  drop constraint device_node_assignments_pkey;

alter table public.device_node_assignments
  add constraint device_node_assignments_pkey primary key (device_id, hop);

-- The column now defaults every future insert to 'EXIT' too, which is only
-- safe because every write path explicitly sets `hop`; drop the default so
-- a future write path that forgets to set it fails loudly (not-null
-- violation) instead of silently landing as EXIT.
alter table public.device_node_assignments
  alter column hop drop default;
