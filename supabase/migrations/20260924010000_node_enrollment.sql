-- Fleet platform Phase 3: node enrollment (spec §20, §54 Phase 3).
--
-- Today a node's API key is generated out-of-band (scripts/register-node.mjs,
-- run by hand with a service-role key) and the raw key is copied onto the
-- VPS manually. This migration lets an admin instead create a PROVISIONING
-- node with no credential yet, hand the VPS only a short-lived, single-use
-- enrollment token, and have the node's own first boot mint its own durable
-- credential via functions/api/agent/enroll.js -- no root SSH from the
-- browser, no service-role key required, no manually inserted DB row.
--
-- Purely additive: existing nodes rows all already have a non-null
-- api_key_hash, so relaxing the NOT NULL constraint changes nothing for
-- them, and the two new columns are nullable with no default.

alter table public.nodes
  alter column api_key_hash drop not null;

alter table public.nodes
  add column enrollment_token_hash text unique,
  add column enrollment_token_expires_at timestamptz;

-- A node with neither a live credential nor a live enrollment token is
-- otherwise indistinguishable from one whose enrollment failed and was
-- never retried -- this index is what a future cleanup job (not part of
-- this phase) would scan to find and retire those.
create index nodes_enrollment_token_expires_at_idx
  on public.nodes (enrollment_token_expires_at)
  where enrollment_token_hash is not null;
