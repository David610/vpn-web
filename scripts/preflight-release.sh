#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "Arcana offline release preflight (read-only with respect to remote infrastructure)"
echo "commit=$(git rev-parse HEAD) branch=$(git branch --show-current)"

npm ci
npm test
npm run lint
npx tsc --noEmit
npm run check-log-secrets
npm run build

# The foundation migrations are immutable on this release branch. A changed
# historical migration must be replaced by a new forward migration.
git diff --exit-code ac4d2ffd22a64bdd95e6572b138caeb8e9e5d3e4 -- supabase/migrations

if command -v pg_isready >/dev/null 2>&1 && pg_isready -q; then
  bash scripts/test-supabase-sql.sh
else
  echo "WARNING: local PostgreSQL is unavailable; SQL replay remains a required CI/live gate." >&2
  [[ "${REQUIRE_LOCAL_SQL:-0}" != "1" ]] || exit 1
fi

node scripts/verify-csp-hydration.mjs
python3 -m http.server 4173 --directory out >/tmp/arcana-preflight-http.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:4173/account/ >/dev/null && break; sleep .2; done
node scripts/a11y-visual-check.mjs
kill "$server_pid" 2>/dev/null || true
trap - EXIT

echo "Running the production gate in an intentionally empty environment; it MUST refuse."
gate_log="$(mktemp)"
if env -i PATH="$PATH" HOME="$HOME" ARCANA_PRODUCTION_DEPLOY=1 node scripts/check-production-config.mjs >"$gate_log" 2>&1; then
  echo "ERROR: production config gate unexpectedly accepted empty configuration" >&2
  rm -f "$gate_log"
  exit 1
fi
grep -q 'BLOCKER:' "$gate_log"
rm -f "$gate_log"
echo "OFFLINE PREFLIGHT PASSED. This is not authorization to deploy."
