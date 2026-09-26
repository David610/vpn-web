#!/usr/bin/env bash
set -euo pipefail

DB="arcana_route_directory_$RANDOM-$RANDOM"
cleanup() { sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

sudo systemctl start postgresql
sudo -u postgres createdb "$DB"

psql_db() { sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

psql_db <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table public.nodes (
  node_id text primary key,
  lifecycle_state text not null default 'READY'
);
insert into public.nodes (node_id) values ('node-1');
SQL

psql_db -f supabase/migrations/20260928000000_route_directory.sql

psql_db <<'SQL'
do $$
begin
  update public.nodes set transport = 'vless-reality', reality_public_key = 'abc',
    reality_short_id = 'def', reality_fingerprint = 'chrome', vless_flow = 'xtls-rprx-vision',
    transport_port = 443, tls_server_name = 'decoy.example.test'
  where node_id = 'node-1';

  if (select count(*) from public.route_directory_state) <> 1 then
    raise exception 'route_directory_state must have exactly one row after migration';
  end if;

  if (select version from public.route_directory_state where id = true) <> 0 then
    raise exception 'route_directory_state.version must start at 0';
  end if;

  begin
    insert into public.route_directory_state (id, version) values (false, 0);
    raise exception 'a second route_directory_state row was incorrectly allowed';
  exception
    when check_violation then null;
  end;
end $$;
SQL

echo "route directory migration test passed"
