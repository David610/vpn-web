-- Fleet Phase 12b: canary rollout for node replacement.
--
-- nodes.lifecycle_state's CHECK constraint (fleet_foundations.sql) enumerates
-- every allowed value explicitly; CANARY needs to be added to it before any
-- row can actually be written with that value. Postgres has no ALTER TABLE
-- ... ALTER CONSTRAINT for a CHECK's expression -- the existing constraint
-- must be dropped and recreated with the wider list.
alter table public.nodes
  drop constraint nodes_lifecycle_state_check;

alter table public.nodes
  add constraint nodes_lifecycle_state_check check (
    lifecycle_state in (
      'PROVISIONING', 'WARMING_UP', 'CANARY', 'READY', 'DEGRADED',
      'DRAINING', 'MAINTENANCE', 'FAILED', 'QUARANTINED', 'RETIRED'
    )
  );
