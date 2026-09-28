-- F-06: dangling DNS / subdomain takeover. Tracks when a node's DNS record
-- was confirmed deleted (fleet-operations.js's RETIRE_OLD_NODE step, or an
-- audited admin override). RETIRED now requires this to be set (see
-- revoke_node_key_and_transition in 20261002000000_node_key_revocation.sql)
-- unless explicitly overridden.

alter table public.nodes
  add column if not exists dns_removed_at timestamptz;
