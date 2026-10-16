#!/usr/bin/env bash
# Builds a self-contained release directory for deploy/vps/install.sh:
#   release/site (static export), server/, functions/, production node_modules, nginx.conf, unit file.
#   ARCANA_DOMAIN=app.example.com NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
#     bash scripts/vps/build-release.sh [release-dir]
# Only PUBLIC values are read here (NEXT_PUBLIC_* are inlined into the browser bundle).
# No service-role key, Stripe key or other secret may be set in this process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DOMAIN="${ARCANA_DOMAIN:?set ARCANA_DOMAIN}"
OUT="${1:-$ROOT/release}"

for forbidden in SUPABASE_SERVICE_ROLE_KEY STRIPE_API_KEY STRIPE_SIGNING_SECRET VPN_SECRETS_ENCRYPTION_KEY SUBSCRIPTION_TOKEN_HASH_KEY; do
  if [ -n "${!forbidden:-}" ]; then echo "refusing to build with $forbidden in the environment" >&2; exit 2; fi
done

export NEXT_PUBLIC_SITE_URL="https://$DOMAIN"
rm -rf "$ROOT/out" "$OUT"
npm run build

mkdir -p "$OUT"
cp -a "$ROOT/out" "$OUT/site"
cp -a "$ROOT/server" "$ROOT/functions" "$OUT/"
find "$OUT" -type d -name __tests__ -prune -exec rm -rf {} +
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$OUT/"
( cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )
cp "$ROOT/deploy/vps/arcana-api.service" "$ROOT/deploy/vps/api.env.example" "$ROOT/deploy/vps/install.sh" "$OUT/"
node "$ROOT/scripts/vps/render-nginx.mjs" --domain "$DOMAIN" --out "$ROOT/out" > "$OUT/nginx.conf"
git -C "$ROOT" rev-parse HEAD > "$OUT/REVISION" 2>/dev/null || date +%s > "$OUT/REVISION"

# A secret must never end up in the browser bundle.
if grep -rIlE "service_role|SUPABASE_SERVICE_ROLE_KEY|sk_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}" "$OUT/site" >/dev/null 2>&1; then
  echo "secret-looking string found in the static bundle" >&2
  exit 3
fi
echo "release ready: $OUT ($(cat "$OUT/REVISION"))"
