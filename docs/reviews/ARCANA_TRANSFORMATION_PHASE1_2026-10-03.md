# Arcana Transformation — Phase 1 Report

Date: 2026-10-03

## Baseline

- Repository: `David610/vpn-web`
- Authoritatively verified starting SHA: `889eca3e24c33e4420b1f494c3584802e5151d89`
- Starting workspace branch: `work` (clean)
- Implementation branch: `codex/arcana-links-foundation`
- `origin/main`: independently confirmed by the operator at the same SHA;
  Cloud networking returned HTTP 403 and was not retried.

Recent main already contained the external subscription gateway, fail-closed
format/mode validation, exact node authorization acknowledgements, monotonic
snapshot versions, and initial empty snapshot support. Phase 1 reused these.

## Changes

- Added the `vpn_links` zero-seat policy container and linked existing
  `external_vpn_devices` as independently credentialed clients.
- Added transactional Link creation/update/revocation and idempotent client
  allocation. Existing subscription capacity and external-device revocation
  remain authoritative.
- Added explicit credential generation/rotation lineage without changing the
  encrypted secret store or node authorization projection.
- Added privacy-safe daily aggregate storage and account/Link read APIs.
- Added account APIs for Link list/create/detail/update/revoke and client
  list/create. Existing external-device endpoints continue to own credential
  replacement, subscription-token replacement, and individual revocation.
- Added focused JavaScript boundary tests and SQL lifecycle/security tests.
- Added the architecture and cross-repository contract document.

Migration: `20261014000000_arcana_links_foundation.sql` only. No historical
migration was edited. Rollback is forward-only in production: deploy a new
corrective migration; do not drop tables with live customer state.

## Reverified P0 findings

1. **Legal — EXTERNAL BLOCKER.** Terms, privacy, and Impressum remain explicit
   drafts/placeholders. The production prebuild gate rejects these and missing
   real site/support identity. No legal or company facts were invented.
2. **Support identity — EXTERNAL BLOCKER.** `site-config.ts` still centrally
   falls back to `arcana.example`; production validation fails safely.
3. **Claim tokens — CROSS-REPO BLOCKER.** This repository issues
   `claim_token`/`lease_expires_at`, rejects mismatched/expired claims, and has
   the `REQUIRE_CLAIM_TOKEN` rollout flag. `singbox-vpn` must echo tokens before
   the flag can safely become mandatory.
4. **Alerts — EXTERNAL CONFIGURATION.** Alerts persist internally. Critical
   alerts have a best-effort Resend adapter only when operator-managed
   credentials/destination exist. Production delivery was not exercised.
5. **Deletion.** Existing deletion is two-phase and coordinates subscription,
   VPN/device revocation, jobs, and identity deletion. Link rows cascade with
   the account; their clients use the existing device revocation path. No live
   Stripe, Supabase, fleet, or identity behavior was claimed as verified.

## Validation record

- `npm ci` — passed; 526 lockfile-resolved packages installed.
- `npm test` — passed; 112 files, 1,094 tests.
- `npm run lint` — passed with 11 pre-existing warnings and zero errors.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed; 41 static pages, CSP nonce post-processing passed.
- `npm run check-log-secrets` — passed; 249 tracked files scanned.
- `ARCANA_PRODUCTION_DEPLOY=1 node scripts/check-production-config.mjs` —
  expected refusal confirmed for missing production site/support values and all
  three draft legal pages.
- `bash scripts/test-supabase-sql.sh supabase/tests/vpn_links_test.sql` — not
  run: the Cloud image has no `createdb`/PostgreSQL client utilities. Migration
  replay and SQL assertions remain mandatory in a PostgreSQL-capable CI job;
  this limitation is not reported as a pass.
- `git diff --check` — passed before commit.

No production service was contacted or mutated. The GitHub fetch restriction
was not retried.

## PR #64 hardening review

GitHub Actions subsequently provided PostgreSQL 16 evidence that the complete
migration smoke/replay job passed. Its SQL-suite job reached the new Link test
after every pre-existing SQL test passed, then exposed an invalid test fixture:
`customer_accounts` has no `name` column. The fixture now uses the real schema.

The hostile-code review also found and fixed three gaps before requesting a CI
rerun:

- usage originally proved account ownership independently for its Link and
  client but did not prove that the client belonged to that Link; the composite
  usage FK now enforces account **and** Link/client association;
- historical credential rows received deterministic generations but not
  deterministic `rotated_from` lineage; the backfill now records it and a
  same-device composite FK prevents cross-client lineage while allowing old
  generations to be pruned;
- the service-role Link-client RPC trusted `p_user_id`; it now requires an
  existing account membership before delegating to the established
  subscription-owned external-device allocator.

Real two-session SQL races now cover Link capacity, identical-key idempotency,
and subscription final-seat capacity through `create_vpn_link_client()`. The
lifecycle SQL test additionally covers foreign subscriptions, cross-account
and non-member client creation, credential lineage, node snapshot advancement,
zero/multiple/already-revoked children, idempotent Link revocation, and an
unrelated external client. HTTP tests cover first delivery, response-loss
retry, concurrent identical retry, key scoping, and the rule that a replay
never receives either the original secret or newly generated unpersisted
material.

The local Cloud image still has no PostgreSQL binaries, and package installation
was blocked by its outbound proxy. Accordingly, the revised SQL has **not**
been represented as locally passing: PostgreSQL-backed CI must rerun it. The
earlier migration-replay pass applies to the pre-hardening revision; the final
head requires a new pass.

Local validation of the hardened revision passed `npm ci`, all 1,098 tests in
112 files, lint (zero errors; the same 11 pre-existing warnings), standalone
TypeScript checking, the production build, the 249-file secret scan, and
`git diff --check`. `bash scripts/test-supabase-sql.sh` was attempted and
stopped immediately at the missing `createdb` executable; it did not execute
or validate any SQL assertion.

## Next session

Phase 2 should (1) validate the migration against real disposable PostgreSQL,
(2) implement and prove the `singbox-vpn` acknowledgement and privacy-safe
counter contract, (3) add the minimal `/account/links` UI using these APIs,
(4) decide legacy-client adoption and safe route-change workflows, and (5)
design WireGuard end to end before exposing it as a configuration family.
