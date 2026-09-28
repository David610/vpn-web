#!/usr/bin/env bash
# Migration-ordering regression test (item 19 of the remediation program /
# F-32-adjacent gap in scripts/test-supabase-sql.sh).
#
# GAP NOTE: this repo has no dated production schema dump from "a few
# months back" -- every migration in supabase/migrations/ was authored
# within the same ~9-day window (2026-09-21 .. 2026-10-05); there is no
# older production-like snapshot checked in anywhere to replay forward
# from. scripts/test-supabase-sql.sh already applies every migration file
# one at a time (not batched into one transaction), so straightforward
# sequential-ordering bugs are already caught. What that script does NOT
# exercise is a database that was pg_dump/pg_restore'd at some earlier
# point in its life (as any real long-lived production database effectively
# is, once anyone re-provisions a replica, staging clone, or does a schema
# migration off a base backup) and then has newer migrations applied on
# top of the *restored* schema rather than the *live* one. Dump/restore can
# surface things incremental replay cannot: default privileges captured at
# dump time, sequence ownership, extension/search_path state, and object
# dependency order chosen by pg_dump rather than by migration authorship
# order.
#
# This script approximates "an older production-like schema" using the
# oldest available proxy: apply migrations only up to a fixed cutover
# point (representing "production a few weeks before the fleet-platform
# work landed"), pg_dump that intermediate schema, pg_restore it into a
# brand new database, then apply the REMAINING migrations on top of the
# restored copy and run the full supabase/tests/*.sql suite against the
# result. If a genuine older production dump is ever captured, drop it in
# and point CUTOFF_MIGRATION at nothing (start the restore from that dump
# instead of the synthetic cutover below).
#
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash scripts/test-supabase-migration-dump-replay.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="arcana_migreplay_$$_${RANDOM}"
CUTOVER="${CUTOVER_MIGRATION:-20260923200000_invite_identity_guard.sql}"
export PGOPTIONS="${PGOPTIONS:-} -c search_path=public,extensions -c client_min_messages=warning"

psql_quiet() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

OLD_DB="${PREFIX}_old"
RESTORED_DB="${PREFIX}_restored"
DUMP_FILE="$(mktemp -t "${PREFIX}.dump")"

created=()
cleanup() {
  rm -f "$DUMP_FILE"
  for db in "${created[@]}"; do
    dropdb --if-exists "$db" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo "cutover migration: $CUTOVER"

# ---- Phase 1: build the "old production" database up to the cutover ----
createdb "$OLD_DB"
created+=("$OLD_DB")
psql_quiet -d "$OLD_DB" -f "$ROOT/scripts/sql/supabase-bootstrap.sql"

found_cutover=0
old_count=0
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"
  psql_quiet -d "$OLD_DB" -f "$migration" >/dev/null
  old_count=$((old_count + 1))
  if [ "$name" = "$CUTOVER" ]; then
    found_cutover=1
    break
  fi
done
if [ "$found_cutover" -ne 1 ]; then
  echo "FAIL: cutover migration '$CUTOVER' not found in supabase/migrations/" >&2
  exit 1
fi
echo "applied $old_count migrations to build the 'old production' schema"

# ---- Phase 2: pg_dump the old schema+data, pg_restore into a fresh DB ----
# Mirrors what actually happens to a long-lived production database far
# more than another `psql -f migration.sql` loop would: pg_dump/pg_restore
# re-creates every object from its own catalog reflection, not by replaying
# the original DDL text.
pg_dump -Fc -d "$OLD_DB" -f "$DUMP_FILE"

createdb "$RESTORED_DB"
created+=("$RESTORED_DB")
pg_restore -d "$RESTORED_DB" --no-owner --no-privileges "$DUMP_FILE"

# ---- Phase 3: apply every migration AFTER the cutover onto the restored DB ----
apply=0
skip=1
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"
  if [ "$skip" -eq 1 ]; then
    if [ "$name" = "$CUTOVER" ]; then
      skip=0
    fi
    continue
  fi
  if ! psql_quiet -d "$RESTORED_DB" -f "$migration" >/dev/null; then
    echo "FAIL: migration $name did not apply cleanly onto a dump-restored schema" >&2
    exit 1
  fi
  apply=$((apply + 1))
done
echo "applied $apply post-cutover migrations onto the restored schema"

# ---- Phase 4: run the full SQL test suite against the reconstructed DB ----
failed=0
for test in "$ROOT"/supabase/tests/*.sql; do
  tname="$(basename "$test" .sql)"
  tdb="${PREFIX}_t_${tname}"
  createdb -T "$RESTORED_DB" "$tdb"
  created+=("$tdb")
  if output="$(psql_quiet -d "$tdb" -f "$test" 2>&1)"; then
    echo "PASS $tname (post-restore)"
  else
    echo "FAIL $tname (post-restore)" >&2
    echo "$output" | sed 's/^/    /' >&2
    failed=$((failed + 1))
  fi
  dropdb --if-exists "$tdb" >/dev/null 2>&1 || true
done

if [ "$failed" -gt 0 ]; then
  echo "$failed SQL test file(s) failed against the dump-restored + forward-migrated schema" >&2
  exit 1
fi
echo "migration dump/restore replay: all tests passed"
