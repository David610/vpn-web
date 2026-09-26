-- Records WHY a node entered FAILED, so automated recovery
-- (node-health-transition.js's evaluateProbeResult) can tell a
-- silence-triggered FAILED -- the one case it was designed to auto-recover
-- from a single passing probe/heartbeat -- apart from a FAILED reached any
-- other way (a canary abort, a boot-timeout, or an admin action), none of
-- which should silently self-heal. Flagged as a hard precondition by both
-- the Phase 12a and Phase 12b specs before FEATURE_AUTO_NODE_HEALTH could
-- safely combine with those other paths into FAILED.
-- Additive only — see docs/ADR/0001 precedent.

alter table nodes
  add column if not exists failed_reason text,
  add constraint nodes_failed_reason_check
    check (failed_reason is null or failed_reason in ('SILENCE', 'CANARY_ABORT', 'BOOT_TIMEOUT', 'ADMIN'));
