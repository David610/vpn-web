# Arcana control plane — remediation report, 2026-09-27

Branch: `claude/arcana-control-plane-remediation` (base `main` @ `4833346`, merges 7 track branches
plus a clean-environment integration-bug-fix commit on top).
Source audit: `docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md`.
Source plan: `docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md`.

This is a remediation pass against the audit's 52 findings, run as 7 parallel tracks (roughly the
cross-repo plan's CP-BILL/CP-FLEET/etc. roles, scoped to this repo only — vpn-web). It is **not**
a re-audit; findings are marked by what was actually implemented and verified in this pass.

No production migration was applied. No live Stripe, Cloudflare, DNS or Hetzner action was taken.
No secret was rotated. Everything below was verified against `npm ci` / `npm test` / `npm run lint`
/ `npm run build` run to completion in a clean, single-tenant checkout of the merged branch
(891/891 tests passing, 0 lint errors, build succeeds) — the individual track agents largely could
not do this themselves (see §3, environment note) and several cross-branch integration bugs were
found and fixed only at this final merge step.

---

## 1. Headline: is this ready for real payments?

**No — one of the two audit P0 blockers is still open.**

- **F-01 (device capacity bypass) — FIXED.** The single `device_entitlement()` SQL gate is wired
  into every credential path this pass could reach.
- **F-02 (out-of-order Stripe events resurrect cancelled subscriptions) — NOT FIXED.** This was
  assigned to the billing track along with 8 other findings; only F-01 was completed in the time
  available (see §3, CP-BILL scope note). **This is the most important open item in this report.**
- **F-03 (production legal gate) — FIXED (code only).** The gate now fails closed on a real
  production deploy signal; the legal text itself was explicitly out of scope (not fabricated).

Do not take real payments until F-02 is closed, in addition to the still-open P1 items in §3.

---

## 2. Findings status

Legend: **FIXED** = implemented + regression test passing in this branch. **PARTIAL** = some of
the finding addressed, a documented gap remains. **DEFERRED** = assigned but not started (budget
ran out). **NOT REPRODUCED** = not attempted, no claim either way. **REQUIRES PRODUCTION ACCESS**
= code/tooling is ready but the last step needs a production credential or David's approval.

| Finding | Status | Notes |
|---|---|---|
| **F-01** device capacity bypass | **FIXED** | `public.device_entitlement(device_id)` (migration `20261001000000`) is the only gate wired into `finalizeCreatedIdentity`, `/api/vpn/config`, `assignDeviceProfile` (covers Telegram assignment too). Regression tests: 3-device-plan denies 4th, +3 pack allows it, two subscriptions don't pool, device move, subscription cancel, suspended account, concurrent registration. **Known gap:** `reconcileAccountProvisioning` (`functions/lib/device-provisioning.js`, CP-BILL-owned) still computes capacity via its own JS logic (`resolveDeviceEntitlements` in `subscriptions.js`), not via the new RPC — flagged by the implementer as a real but non-regressive duplication, not a live bug, because the JS logic already agrees with the SQL rule. Should still be unified. |
| **F-02** out-of-order Stripe events | **DEFERRED** | Not started. `subscriptions.stripe_synced_at` (needed for the conditional-write guard in contract C-14) does not exist yet. **P0 — highest priority follow-up.** |
| **F-03** production legal gate opt-in | **FIXED** | `check-production-config.mjs` now detects production from `CF_PAGES=1` + `CF_PAGES_BRANCH == main` (configurable via `ARCANA_PRODUCTION_BRANCH`), not only an opt-in flag; fails the build closed on any draft marker/placeholder. Legal text itself untouched (out of scope, not fabricated). |
| **F-04** plaintext VPN URLs in `provisioning_jobs.result` | **FIXED** (purge is REQUIRES PRODUCTION ACCESS) | `complete.js` now allowlists `vpn_user_id` + `*_reported` booleans only; the actual secret URLs are never written to that column again (verified: `/api/vpn/config` only ever reads `vpn_secrets`). `admin-sanitize.js` now redacts any URL/token/secret/credential/password-shaped key, not just `subscription_url`. `scripts/purge-plaintext-urls.mjs` written (dry-run by default, `--confirm` required) to clean up existing rows — **not run**, needs an operator with production DB access and approval. |
| **F-05** node key never revoked | **FIXED** | `revoke_node_key_and_transition` RPC (migration `20261002000000`): one transaction clears `api_key_hash`/`revoked_at`, fails pending/claimed jobs, deletes lease slots + probe credentials, bumps route-directory version. `authenticateNode` also now rejects `lifecycle_state` QUARANTINED/RETIRED directly. New admin rotate-key action. Enumerated-route test asserts every `/api/agent/*` handler (except the now-410 `metrics.js`, which needs no auth) returns 401 for a quarantined key. |
| **F-06** dangling DNS on retire | **FIXED** (production cleanup REQUIRES PRODUCTION ACCESS) | `RETIRE_OLD_NODE` deletes the Cloudflare record and verifies via lookup **before** destroying the Hetzner instance; new `nodes.dns_removed_at` column, RETIRED transition refused unless it's set (or an audited override). **Not done:** a scheduled sweep for abandoned FAILED nodes with zero assignments (nothing currently triggers their DNS/instance cleanup). If a dangling record already exists from before this fix, it needs a manual one-off cleanup with production Cloudflare/Hetzner access. |
| **F-07** admin disable broken / not durable | **PARTIAL** | Groundwork only: `customer_accounts.suspended_at` added and `device_entitlement()` already honors it (denies with `account_suspended`). The `.maybeSingle()` 500 bug in `disable.js`/`enable.js`/`rotate*.js`, the actual suspend admin action, and "reconcile must never re-enable a suspended account" are **not implemented**. |
| **F-08** account deletion not atomic | **DEFERRED** | Not started. Current order (mark deletion → ban → cancel Stripe → revoke devices) is still the wrong order the audit flagged; C-05's cancel-then-revoke-then-ban order was not implemented. |
| **F-09** claimed jobs never re-queued | **DEFERRED** | Not started — flagged by the CP-FLEET implementer as a real protocol change (claim-token contract shared with the sibling singbox-vpn agent repo) too large to do partially in the time available. |
| **F-10** customer-triggerable node restarts | **DEFERRED** | Not started — `rotate-credentials.js`, device add/remove and profile-assignment mutation budgets are outside every track's file ownership as scoped (fell into a gap between CP-BILL and CP-FLEET). |
| **F-12** legacy member billing bypass | **DEFERRED** | Not started (assigned to CP-BILL along with F-02; budget ran out after F-01). `setExtraPacks` et al. in `account-service.js` still do not check `role === 'owner'`. |
| **F-13** no rate limiting on auth/abuse routes | **PARTIAL** | `functions/lib/rate-limit.js` (new, Postgres-backed atomic fixed-window counter, migration `20260930020000`) is built and wired into Telegram `link`/`link-code` (F-49, below). **Not wired into** `/v1/auth/login`/`register`/`refresh` — those files are CP-BILL-owned and were explicitly left alone to avoid a merge conflict; a concrete call-shape handoff was left in the web-auth track's report for whoever picks up CP-BILL's remaining items. Password reset has no server-side route to rate-limit (client calls Supabase directly) — relies on GoTrue's own throttling. |
| **F-14** open redirect | **FIXED** | `safeNextPath` now resolves via `new URL(candidate, origin)`, requires same-origin, rejects control characters/backslashes pre- and post-decode. Regression tests cover the known bypass strings (`/\t/evil.test`, `//evil.test`, `/\\evil.test`, encoded variants). |
| **F-15** localStorage sessions / no `script-src` CSP | **PARTIAL** | Full HttpOnly-cookie migration explicitly out of scope (static export + Pages Functions architecture). CSP hardened: `script-src 'self'` (no unsafe-inline/eval), `connect-src` scoped to Supabase + self, `object-src 'none'`, `frame-ancestors 'none'`, Telegram Mini App gets its own narrow carve-out. **Explicitly does not close the localStorage risk** — any script that does execute in-origin can still read the token; this raises the XSS bar, it does not fix F-15's root cause. |
| **F-17** node revision rollout always fails | **FIXED** | Deterministic `idempotency_key` (`apply-revision:<node>:<revision>`) added; revision row + desired_revision + job now write together. |
| **F-18** privacy retention | **FIXED** | New `functions/lib/retention.js` + `/api/internal/retention-tick.js`: `vpn_leases` 30d, `stripe_events.payload` trimmed after 90d, `provisioning_jobs` 90d (terminal only), `node_traffic_samples` 7d, `telegram_link_codes` 1d past expiry, `node_revisions` keep-last-2, stale revoked-device metadata cleared 90d, `operational_alerts` 30d (resolved only). All env-configurable, each step isolated so one failure doesn't block the rest. |
| **F-19** legacy expiry no grace / not pushed on `updated` | **DEFERRED** | Not attempted this pass. |
| **F-20** no failover / lazy silence detection / passive drain | **PARTIAL** | Silence-detection sweep now runs every fleet-tick minute unconditionally, not only as a side effect of another node's heartbeat or an admin page view. **Not done:** make-before-break re-placement of legacy devices off FAILED/DRAINING nodes within 2 ticks (the REPLACE_NODE path already won't retire under live assignments, but there's no standalone driver independent of an explicit replace operation). |
| **F-21** dead/legacy routes | **PARTIAL** | `/api/vpn/usage` and `/api/agent/metrics` now return `410 Gone` (previously silent dead code with no producer anywhere); `UsageCard.tsx` (unused) removed. `/api/cancel-subscription`, `/api/resume-subscription` and `/api/vpn/rotate-credentials` were investigated but intentionally **not** edited by this track (they overlap CP-BILL's F-12 and CP-FLEET's F-10, both still open) — left for those tracks. |
| **F-22** session revocation gaps | **FIXED** (with a documented residual gap) | Password change now calls `admin.signOut(currentToken, "others")`, revoking every other session. Documented, not fixed: on a future move to asymmetric (RS256/ES256) JWT signing keys, already-issued access tokens verified via local JWKS would not re-check revocation state mid-lifetime — tracked separately, needs the key-migration work first. |
| **F-27** `gotrue.js` service-role fallback | **FIXED** | Requires `SUPABASE_ANON_KEY`; throws before any fetch if missing — no fallback to the service-role key for a public call. |
| **F-28** hard-coded personal alert email | **FIXED** | `ALERT_TO_EMAIL` env var, fails closed (log-only) if unset — the hard-coded personal address is gone. User id truncated, agent-supplied error text sanitized/length-capped before going into an email. |
| **F-29** production not at `main` / no deploy provenance | **FIXED** | New `/api/version` returns the deployed git SHA (`CF_PAGES_COMMIT_SHA`). A full migration-vs-code drift check was intentionally kept lightweight, not over-engineered. |
| **F-31** Stripe base price not validated | **DEFERRED** | Not started (assigned to CP-BILL; budget ran out after F-01). Noted in the F-01 migration's comments as a follow-on (`subscriptions` has no `stripe_price_id` column yet). |
| **F-32** SQL tests stale / not in CI | **FIXED** (pre-existing, verified) | Already fixed before this pass (`test(db): run supabase/tests on replayed migrations in CI`, merged from `remediation/cp-billing-entitlement`); this pass extended RLS test coverage to the 5 previously-uncovered browser-accessible tables and proved (not just documented) that the `account_members` sub-select policy dependency fails closed. |
| **F-33** missing REVOKEs / `search_path=public` | **FIXED** | Migration `20261005000000`: revokes `anon`/`authenticated` grants on `node_probe_credentials`/`node_probe_results` and their sequence; sets `search_path=''` on the 4 flagged SECURITY DEFINER functions. |
| **F-35** one-click paid pack, no confirmation | **DEFERRED** | Not started (frontend work, assigned to CP-BILL; budget ran out after F-01). |
| **F-36** silent failures / no alerting | **PARTIAL** | `functions/lib/logging.js` (structured JSON logs, request-id threading, secret redaction by key-name and value-shape) and `functions/lib/alerts.js` (generalized `raiseAlert`/`resolveAlert`) built and unit-tested, plus a CI-time `check-log-secrets.mjs` grep guard (ran clean: 219 files scanned, no secret-shaped literals in log calls). **Not wired into** the actual call sites the audit names (stripe-webhook, device-provisioning, scheduler, route-directory/signing, dns-adapter, node-*, heartbeat) — all of those are CP-BILL/CP-FLEET-exclusive files; specific alert-condition handoffs were sent to both tracks. No paging/on-call integration exists or was added — every condition is alerts-table-only until someone adds PagerDuty/Opsgenie/Slack. |
| **F-39** admin audit log best-effort/mutable | **PARTIAL** | `writeAdminAudit` now throws (fails the request) instead of logging-and-continuing on an insert failure — verified every one of its 12 call sites already propagates that into an error response. True transactional coupling (single RPC covering mutation + audit atomically) is still a follow-up for CP-BILL/CP-FLEET, since all 12 call sites live in their exclusive files. |
| **F-42** `npm ci --legacy-peer-deps` / lint scope | **FIXED** | `@types/node` bumped `^20`→`^22`, resolving the `vitest@5` peer conflict — **verified**: clean-environment `npm ci` (no flag) succeeds. `lint` script now also runs `eslint functions scripts --ext .js,.mjs`, closing the gap where `next lint` skipped those directories — **verified**: 0 errors (11 pre-existing harmless warnings unrelated to this pass). |
| **F-44** public pages ship Supabase SDK | **FIXED** | `Nav`/`HeroActions` now read the `arcana-auth-v1` localStorage key directly via a new hook instead of calling `useSession()`; the SDK is dynamically imported only where auth is actually used. **Verified via a real build**: `/pricing`, `/locations`, `/terms`, `/privacy`, `/impressum` dropped to ~107 kB First Load JS (was 172 kB in the audit baseline). `/` itself is still 172 kB — not yet explained, needs a follow-up look at what else `/` pulls in. |
| **F-49** Telegram link/link-code no rate limit | **FIXED** | Wired into the same `rate-limit.js` infra as F-13: 5 codes/10min per account, 5 verification attempts/10min per (unspoofable, initData-signed) Telegram user id, 30/10min per-IP backstop. Fails open on any limiter/DB error so an outage never blocks legitimate auth. |
| **F-43** per-request GoTrue round trip | **REQUIRES PRODUCTION ACCESS** | Documented, not implemented: closing this needs migrating the hosted Supabase project to asymmetric JWT signing keys (a dashboard/production config change), not a code change here. Implementing a local HMAC short-circuit instead was explicitly declined as too risky to rush in an auth-critical path without dedicated review. |
| **F-50** PostgREST 1000-row truncation | **DEFERRED / HANDOFF** | Confirmed still present in `functions/api/admin/fleet/{assignments,health}.js` (CP-FLEET-exclusive); measured and handed off, not fixed. |
| Everything else not listed (F-11, F-16, F-23–26, F-30, F-34, F-37–38, F-40–41, F-45–48, F-51–52) | **NOT REPRODUCED / NOT ATTEMPTED** | Out of scope for this pass's 7 tracks; no claim either way. |

---

## 3. What actually happened, track by track

Seven agents ran in parallel, each on its own branch off `claude/arcana-control-plane-remediation`,
scoped to the file ownership in the cross-repo plan's §6 (CP-BILL / CP-FLEET) plus five additional
tracks covering the rest of this repo's findings. All seven branches are merged into
`claude/arcana-control-plane-remediation` and pushed.

**Environment note (affects every track):** all seven agents ran as concurrent sandboxes sharing
this machine's npm cache and, in two cases, no network/Postgres access at all. Every track reported
being unable to run `npm ci`/`npm test`/`npm run lint`/`npm run build` to completion themselves —
work was self-reviewed against existing test/mock conventions instead. **This pass re-verified for
real**, in a clean single-tenant checkout, after merging: `npm ci` (no flag, clean), `npm test`
(891/891 passing), `npm run lint` (0 errors), `npm run build` (succeeds, bundle sizes measured).
Doing so surfaced and fixed 4 genuine cross-branch integration bugs (three test-mock/fixture bugs,
one lint error) — see the `fix(tests): repair cross-branch test integration bugs` commit. No
production code defect was found in this final pass; everything wrong was in test scaffolding that
had never actually been run.

- **db-rls** — F-33, RLS test coverage, `npm ci` fix, migration-replay proxy script (no genuine
  months-old production schema exists in this ~9-day-old migration history to replay from; documented
  as a gap rather than faked).
- **web-auth** — F-14, F-15 (partial), F-27, F-22, F-39 (partial), F-49, plus the shared
  `rate-limit.js` infra (F-13 partial).
- **privacy** — F-04, F-18, F-28, privacy page's false abuse-IP claim removed (left legal-text TODOs
  as TODOs, did not fabricate).
- **cp-fleet** — F-05, F-06, F-17, F-20 (partial); F-09 and F-10 explicitly deferred as
  out-of-budget/out-of-ownership-scope rather than rushed.
- **cp-bill** — **only F-01 of 9 assigned findings was completed.** The implementer's own report is
  explicit about this: "I want to be explicit about that rather than claim partial credit across all
  nine." F-02, F-12, F-31, F-08, F-13, F-35 and all P2/P3 items in its scope are untouched; F-07 got
  groundwork only. **This is the single biggest gap in this remediation pass** — see §4.
- **observability-perf** — F-44 (fixed, build-verified), F-36 infrastructure built but not wired
  into owned call sites (handed off with specific conditions), F-43/F-50/N+1-reconcile measured and
  hand-offed rather than editing files outside scope.
- **gate-legacy-tests** — F-03, F-29, F-21, F-42. This agent's session was interrupted before it
  committed its own work; the completed code was recovered from its worktree and committed manually
  in this pass (commit `ed6da9d`) rather than lost.

---

## 4. Blockers to close before this control plane can take real payments

In order:

1. **F-02 (Stripe event ordering) — P0, completely open.** The single highest-priority follow-up.
   Needs: `subscriptions.stripe_synced_at` column + conditional-write guard in every
   `customer.subscription.*`/`invoice.*` handler, `canceled` made sticky, permutation tests.
2. **F-08 (deletion saga order) — P1, completely open.**
3. **F-12 (legacy member owner-role enforcement) — P1, completely open.**
4. **F-31 (Stripe price allowlist) — P1, completely open.**
5. **F-07 (admin disable) — P1, groundwork only** (`suspended_at` exists and is honored by the new
   entitlement gate, but the actual disable action and the 500 bug are unfixed).
6. **F-09 (job lease/reclaim) and F-10 (customer-triggered restart DoS) — P1, completely open.**
7. **F-19, F-13 (full auth-route rate limiting), F-20 (full failover), F-36 (alerting wired to
   real call sites), F-39 (transactional audit coupling) — all partial, need finishing.**
8. **F-04's production purge and F-06's abandoned-node DNS/instance cleanup — REQUIRES PRODUCTION
   ACCESS / David's approval**, code and dry-run tooling are ready.
9. Legal text itself (F-03's actual Terms/Privacy/Impressum content) is unstarted by design — this
   pass only fixed the gate's mechanics.

## 5. Rollback plan

Every change in this branch is additive at the schema level (new tables/columns/functions; no
existing migration was edited, per the cross-repo plan's rule). Rolling back is: revert the merge
commit range on `main` (or simply don't merge), and do not run migrations
`20260930020000`–`20261005000000` against a real database. No live system was touched, so there is
nothing to undo outside git and the local test database used for verification.

## 6. Test evidence

```
npm ci                # clean, no --legacy-peer-deps, 392 packages, 0 vulnerabilities
npm test               # 87 test files, 891 tests, 891 passed
npm run lint            # next lint: 0 warnings; eslint functions scripts: 0 errors, 11 pre-existing warnings
npm run build            # 41 static pages, succeeds; public legal/marketing pages ~107 kB First Load JS
```

Not run in this pass (require infrastructure this session does not have): `supabase/tests/*.sql`
against a live Postgres, the migration-replay-from-older-schema proxy script, Playwright/a11y visual
checks, any protocol/VPS/device-tier test from the cross-repo plan's §7.1, and all production
read-only verification queries from the audit's §22.
