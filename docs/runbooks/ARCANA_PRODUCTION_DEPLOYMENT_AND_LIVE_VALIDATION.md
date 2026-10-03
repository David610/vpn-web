# Arcana production deployment and live validation

**Release status:** `OFFLINE-QUALIFIED RELEASE CANDIDATE` only. Passing this document does not by itself make the service production-ready. Never paste credentials into tickets, logs, screenshots, or this repository.

## Automated now

Prerequisite: Node 22, npm, Chromium dependencies, Wrangler, and (for authoritative SQL locally) PostgreSQL 16 on a disposable database.

```bash
git switch codex/arcana-web-release-candidate
REQUIRE_LOCAL_SQL=1 PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres npm run preflight-release
```

Expected: all unit, lint, TypeScript, build, log-secret, migration-diff, migration replay/SQL, CSP hydration, and accessibility checks pass; the intentionally empty production configuration is rejected with `BLOCKER` lines. Failure means stop; do not deploy. Save the complete log and commit SHA as evidence. The GitHub `sql-tests` job is the authoritative clean PostgreSQL migration/RLS/function/race suite.

Canonical customer paths are `/account`, `/account/devices`, `/account/links`, `/account/links/new`, `/account/links/detail?id=…`, `/account/subscription`, `/account/billing`, `/account/settings`, and `/account/help`. The query-based detail path is intentional because the Cloudflare Pages artifact is a static export and cannot pre-render arbitrary Link UUIDs. Legacy `/account/subscriptions` and `/account/security` remain compatible.

## Run immediately after Cloudflare access returns

### 1. Configure, but do not deploy

Prerequisite: access to the intended Pages projects, reviewed origin/domain values, production Supabase and Stripe values, and completed legal/identity inputs.

```bash
npx wrangler whoami
npx wrangler pages project list
npx wrangler pages secret list --project-name arcana-web
ARCANA_PRODUCTION_DEPLOY=1 node scripts/check-production-config.mjs
```

Expected: correct account/project, all bindings named by the gate, and `production placeholder gate passed`. Any wrong account, missing binding, placeholder, or gate warning is a stop condition. Save redacted command output; never save values.

### 2. Rehearse the exact artifact locally

```bash
npm ci && npm run build
npx wrangler pages dev out --port 8788 --local --persist-to .wrangler/state
```

In a second shell:

```bash
curl -fsSI http://127.0.0.1:8788/ | tee evidence-home-headers.txt
curl -fsSI http://127.0.0.1:8788/account/ | tee evidence-account-headers.txt
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/not-a-route
node scripts/verify-csp-hydration.mjs
```

Expected: public/account HTML is 200; headers include CSP, `nosniff`, frame denial and restrictive permissions; unknown route is 404; Chromium hydrates without CSP violations. Missing headers, a 200 fallback for the unknown path, or browser errors means stop and fix the artifact. Save headers, browser log, screenshots, and `_headers` hash.

### 3. Prepare the future admin-origin boundary

Do not split during an incident or combine this with the first production release. Create a second Pages project from the same reviewed commit, set its custom domain to `admin.<production-domain>`, and restrict its build/deployment to the admin artifact once a dedicated admin build exists. Set `ADMIN_ORIGIN=https://admin.<production-domain>` on both projects; keep admin CSP free of third-party script/connect origins. In Cloudflare DNS create the Pages-provided CNAME only after Pages verifies ownership. Require Access/IP policy if approved, but retain application AAL2/RBAC.

Validate before changing customer routing:

```bash
curl -fsSI https://admin.<production-domain>/admin/login/ | tee evidence-admin-headers.txt
curl -fsS https://admin.<production-domain>/api/admin/overview -o /dev/null -w '%{http_code}\n'
```

Expected: strict admin CSP and unauthenticated API rejection (401). A 200 API response, shared customer session, relaxed CSP, or DNS pointing at the wrong project is a stop condition. Roll back by removing the new custom-domain association/CNAME; do not weaken AAL2 or RBAC. Evidence: DNS record export, Pages deployment SHA, headers, and an AAL2/RBAC audit event.

## Run immediately after Supabase access returns

Prerequisite: Supabase CLI authenticated to the explicitly selected project; a fresh backup; no production mutation approval is implied.

```bash
supabase login
supabase projects list
supabase link --project-ref '<EXPECTED_PROJECT_REF>'
supabase db diff --linked --schema public,auth
supabase migration list --linked
```

Expected: project identity is exact, diff contains no unexplained drift, and every repository migration has a linked counterpart. Any identity uncertainty or destructive/unexplained diff means stop. Save the diff and migration list.

Dry-run in a restored disposable database first:

```bash
createdb arcana_release_rehearsal
PGDATABASE=arcana_release_rehearsal bash scripts/test-supabase-sql.sh | tee evidence-sql.txt
dropdb arcana_release_rehearsal
```

Expected: all migrations and SQL assertions pass, including RLS, entitlement, account deletion, Link capacity/idempotency races, and provisioning transitions. Never aim this command at production. Failure means no migration push. Save test log plus backup identifier. Only after review and a rollback window may the operator run `supabase db push --linked --dry-run`; inspect output before a separately approved `supabase db push --linked`.

## Run after VPS access returns

### Claim-token rollout precheck

Keep `REQUIRE_CLAIM_TOKEN=false`. The authoritative precondition is the normalized, fresh capability evidence reported by every operationally eligible node (PROVISIONING, WARMING_UP, CANARY, READY, DEGRADED, or DRAINING). Intentionally offline/security/terminal states are excluded.

```bash
SUPABASE_URL='https://<project-ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<operator-supplied>' \
ARCANA_PROJECT_REF='<project-ref>' \
ARCANA_EXPECTED_COMMIT='<reviewed-vpn-web-commit>' \
node scripts/check-claim-token-fleet.mjs --evidence=claim-token-fleet-evidence.json
```

Expected: the target project ref is printed, every eligible node has capability evidence no older than the fleet liveness threshold, every version is compatible, and the final line is `CLAIM TOKEN FLEET READINESS: PASS`. A zero-node fleet is not proof and fails. The evidence file contains no credentials; retain it with the release record. A failure or uncertain project identity is a stop condition.

`CLAIM_TOKEN_FLEET_VERIFIED=true` is an explicit operator acknowledgement of that saved machine result, never a substitute for it. After PASS and review, set the acknowledgement and run:

```bash
CLAIM_TOKEN_FLEET_VERIFIED=true REQUIRE_CLAIM_TOKEN=true ARCANA_PRODUCTION_DEPLOY=1 node scripts/check-production-config.mjs
```

Expected: gate passes. In a separately approved deployment: enable a canary, observe claims/leases and capability-regression alerts, then expand. Only that separately approved deployment may change `REQUIRE_CLAIM_TOKEN=true`. Roll back immediately to `false` if valid jobs are rejected, claims expire unexpectedly, stale completions rise, or nodes stop completing work. The required sequence is **machine check → save evidence → operator acknowledgement → config gate → canary → observe → expand**.

If heartbeat evidence is missing or disputed during an incident, direct SSH remains a fallback: check `systemctl is-active vpn-provisioning-agent`, the pinned agent version, and redacted recent claim/lease logs on that node. SSH evidence does not turn a failing fleet preflight into PASS; repair reporting and rerun the command.

### Node/data-plane smoke

```bash
curl -fsS https://'<node-health-endpoint>'/health
systemctl status vpn-provisioning-agent --no-pager
journalctl -u vpn-provisioning-agent --since '15 minutes ago' --no-pager
```

Expected: healthy node, no secret material, successful authorization snapshot/ACK, and no repeated stale/missing ACK. Malformed response, empty snapshot when entitlements exist, authorization lag, or offline node means disable the affected route and stop rollout. Save redacted health response, service status, snapshot version/ACK correlation IDs—never credentials.

## Post-deploy smoke (only after separate approval)

Use a dedicated test account and Stripe test-mode project first. Exercise login, overview, device rename/move/revoke, Link create/add/replay/replace/client revoke/Link revoke, subscription active/past-due/cancelled views, portal handoff, expired session, and backend outage. Confirm a first Add Client response shows its URL once; refresh/back/replay must not show it. Save screenshots with the URL fully redacted and correlation IDs. Any secret in URL query, storage, logs, telemetry, admin APIs, or ordinary reads requires immediate rollback.

## External legal/identity requirements

Supply and obtain approval for: production origin/domain; legal operator name, physical/legal address and jurisdiction; final Terms; final Privacy Policy; final Impressum; real support mailbox/identity; alert sender and recipient; billing statement/support identity. These are blockers, not defaults. The production gate must continue failing until supplied.

## Privacy and evidence rules

Allowed customer usage is aggregate bytes/connections and coarse last-seen only. Do not collect sites, URLs, DNS queries, destination IP history, payloads, searches, bearer tokens, or third-party private configuration. Operational evidence may contain event type, non-secret object ID, status, timestamp, and correlation ID. Redact credentials and subscription URLs before saving evidence.
