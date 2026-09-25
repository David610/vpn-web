-- Phase 8: per-node data-plane health-probe streak tracking, used by
-- functions/lib/node-health-transition.js to drive automated
-- READY/DEGRADED/FAILED lifecycle transitions with hysteresis.
-- Additive only — see docs/ADR/0001 precedent.

alter table nodes
  add column if not exists consecutive_probe_failures int not null default 0,
  add column if not exists consecutive_probe_successes int not null default 0,
  add column if not exists last_probe_at timestamptz,
  add column if not exists last_probe_ok boolean;
