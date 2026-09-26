-- Fleet Phase 14 follow-on / ADR-0002 sub-project A: a node's public
-- transport parameters (never its private key -- see NODE_BOOTSTRAP.md's
-- Credentials table for the existing precedent) and a singleton counter
-- for the signed route directory's monotonic version.
-- Additive only -- see docs/ADR/0001 precedent.

alter table nodes
  add column if not exists transport text,
  add column if not exists reality_public_key text,
  add column if not exists reality_short_id text,
  add column if not exists reality_fingerprint text,
  add column if not exists vless_flow text,
  add column if not exists hysteria2_obfs_type text,
  add column if not exists transport_port int,
  add column if not exists tls_server_name text;

create table if not exists route_directory_state (
  id boolean primary key default true,
  version bigint not null default 0,
  last_payload_hash text,
  constraint route_directory_state_singleton check (id)
);
insert into route_directory_state (id) values (true) on conflict do nothing;
