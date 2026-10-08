# Local end-to-end verification

Runs the real stack on one machine: Supabase (Postgres, GoTrue auth, PostgREST),
the Cloudflare Pages Functions runtime and the built site. Only Stripe is absent
(the suites seed a subscription row), and Telegram is simulated by signing
`initData` exactly as Telegram does. Nothing here touches a hosted project.

Last verified 2026-10-08: SQL 12/12 files, portal 37/37, Telegram 44/44, admin 28/28.

## 1. SQL layer (migrations, RLS, concurrency)

```bash
docker run -d --name arcana-sqltest -e POSTGRES_PASSWORD=postgres \
  -v "<repo>:/repo:ro" public.ecr.aws/supabase/postgres:17.6.1.167
# the concurrency suites use dblink, which needs a superuser role
docker exec -e PGHOST=localhost -e PGUSER=supabase_admin -e PGPASSWORD=postgres arcana-sqltest \
  bash /repo/scripts/test-supabase-sql.sh
```

Replays every migration, loads `seed.sql`, then runs each `supabase/tests/*.sql`
in its own database. On Windows, strip CRLF from the script first
(`sed 's/\r$//' ... | bash`) and set `MSYS_NO_PATHCONV=1` in Git Bash.

## 2. Full stack

Use a separate project id and ports so this cannot collide with another stack:

1. Copy `supabase/` to a scratch directory. In its `config.toml` set
   `project_id = "arcana-e2e"`, shift every port by 1000 (API 55321, DB 55322, …),
   `[auth.email] enable_confirmations = false`, `[auth.mfa.totp] enroll_enabled = verify_enabled = true`,
   and `site_url = "http://127.0.0.1:8788"`.
2. `supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,postgres-meta`
   (applies all migrations).
3. Seed two nodes and routes: `docker exec -i supabase_db_arcana-e2e psql -U postgres -f scripts/e2e/seed.sql`.
4. Build against that stack, then stamp the CSP nonce (the `postbuild` hook does
   this for `npm run build`; it does **not** run for `npx next build`):

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> \
   NEXT_PUBLIC_SITE_URL=http://127.0.0.1:8788 npx next build
   node scripts/apply-csp-nonce.mjs
   ```

   For local runs only, add `http://127.0.0.1:55321` to `connect-src` in `out/_headers`.
5. Start the Functions runtime:

   ```bash
   npx wrangler pages dev out --port 8788 --ip 127.0.0.1 \
     --compatibility-date 2026-09-20 --compatibility-flag nodejs_compat \
     --binding SUPABASE_URL=http://127.0.0.1:55321 --binding SUPABASE_SERVICE_ROLE_KEY=<service-role> \
     --binding SUPABASE_ANON_KEY=<anon> --binding SITE_URL=http://127.0.0.1:8788 \
     --binding SUBSCRIPTION_TOKEN_HASH_KEY=<32+ random chars> --binding VPN_SECRETS_ENCRYPTION_KEY=<64 hex> \
     --binding TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```

## 3. Run the suites

```bash
export ANON_KEY=<anon> SERVICE_ROLE_KEY=<service-role>
node scripts/e2e/portal.cjs     # signup, login, create/copy/replace/move/revoke, capacity, isolation
node scripts/e2e/telegram.cjs   # linking, every Mini App route, 1 h fresh-initData rule, UI
node scripts/e2e/admin.cjs      # real TOTP MFA, directory counts, metadata-only detail, audit, login form
```

`telegram.cjs` waits about a minute on purpose: the per-user write limiter allows 10 writes a minute.
Each run creates its own users, so re-running is safe.

## What this does not cover

Real Stripe checkout and webhooks, a real Telegram client, real VPN nodes and tunnels
(leaks, kill switch, network changes), and the hosted Supabase/Cloudflare projects.
