#!/usr/bin/env bash
# Replays every migration on an empty PostgreSQL database shaped like a fresh
# Supabase project (scripts/sql/supabase-bootstrap.sql), loads
# supabase/seed.sql, then runs each supabase/tests/*.sql in its own copy of
# that database. Any error or RAISE in a test file fails the run.
#
# Connection: the standard libpq variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD). The user must be able to create roles and databases.
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/test-supabase-sql.sh
#   bash scripts/test-supabase-sql.sh supabase/tests/rls_test.sql   # one file
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="arcana_sqltest_$$_${RANDOM}"
TEMPLATE="${PREFIX}_tpl"
export PGOPTIONS="${PGOPTIONS:-} -c search_path=public,extensions -c client_min_messages=warning"

psql_quiet() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

created=()
cleanup() {
  for db in "${created[@]}"; do
    dropdb --if-exists "$db" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

createdb "$TEMPLATE"
created+=("$TEMPLATE")

psql_quiet -d "$TEMPLATE" -f "$ROOT/scripts/sql/supabase-bootstrap.sql"

count=0
for migration in "$ROOT"/supabase/migrations/*.sql; do
  if ! psql_quiet -d "$TEMPLATE" -f "$migration" >/dev/null; then
    echo "FAIL migration $(basename "$migration")" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "applied $count migrations"

psql_quiet -d "$TEMPLATE" -f "$ROOT/supabase/seed.sql" >/dev/null
echo "loaded seed.sql"

if [ "$#" -gt 0 ]; then
  tests=("$@")
else
  tests=("$ROOT"/supabase/tests/*.sql)
fi

failed=0
for test in "${tests[@]}"; do
  name="$(basename "$test" .sql)"
  db="${PREFIX}_${name}"
  createdb -T "$TEMPLATE" "$db"
  created+=("$db")
  if output="$(psql_quiet -d "$db" -f "$test" 2>&1)"; then
    echo "PASS $name"
  else
    echo "FAIL $name" >&2
    echo "$output" | sed 's/^/    /' >&2
    failed=$((failed + 1))
  fi
  dropdb --if-exists "$db" >/dev/null 2>&1 || true
done

if [ "$failed" -gt 0 ]; then
  echo "$failed SQL test file(s) failed" >&2
  exit 1
fi
echo "all ${#tests[@]} SQL test files passed"
