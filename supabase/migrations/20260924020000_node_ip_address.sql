-- Fleet platform Phase 4: provider adapters (spec 54 Phase 4).
--
-- A provider adapter's createInstance() call returns the VPS's public IP
-- immediately -- long before the node ever calls /api/agent/enroll.js or
-- sends its first heartbeat -- so the admin UI has something to show while
-- a node sits in PROVISIONING/WARMING_UP. Nothing on `nodes` captured that
-- today. Purely additive and nullable: existing rows (manually provisioned,
-- IP known only to whoever SSH'd in) stay null until backfilled by hand or
-- their next heartbeat, once heartbeat is taught to report it (not part of
-- this phase).
alter table public.nodes
  add column ip_address inet;
