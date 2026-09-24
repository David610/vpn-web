#!/usr/bin/env bash
set -euo pipefail

# Targeted fallback for the node-enrollment migration when Supabase's
# container registry is unavailable. Asserts:
#   - a pre-existing node (api_key_hash already set) is unaffected
#   - a PROVISIONING node can be created with api_key_hash null and an
#     enrollment_token_hash instead
#   - enrollment_token_hash uniqueness is enforced

DB="arcana_node_enrollment_$RANDOM-$RANDOM"
cleanup() {
  sudo -u postgres dropdb --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sudo systemctl start postgresql
sudo -u postgres createdb "$DB"

psql_db() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" "$@"
}

psql_db <<'SQL'
create table public.nodes (
  node_id text primary key,
  api_key_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Pre-dates the migration, same as the fleet-foundations fallback test's
-- convention: prove the relaxed constraint doesn't touch existing rows.
insert into public.nodes (node_id, api_key_hash) values ('node-1', 'existing-hash');
SQL

psql_db -f supabase/migrations/20260924010000_node_enrollment.sql

psql_db <<'SQL'
do $$
begin
  if (select api_key_hash from public.nodes where node_id = 'node-1') <> 'existing-hash' then
    raise exception 'the pre-existing node''s api_key_hash was unexpectedly changed';
  end if;

  insert into public.nodes (node_id, enrollment_token_hash, enrollment_token_expires_at)
  values ('node-2', 'token-hash-1', now() + interval '1 hour');

  if (select api_key_hash from public.nodes where node_id = 'node-2') is not null then
    raise exception 'a PROVISIONING node should have no api_key_hash yet';
  end if;

  begin
    insert into public.nodes (node_id, enrollment_token_hash, enrollment_token_expires_at)
    values ('node-3', 'token-hash-1', now() + interval '1 hour');
    raise exception 'a duplicate enrollment_token_hash was incorrectly allowed';
  exception
    when unique_violation then null;
  end;
end $$;
SQL

echo "node enrollment migration test passed"
