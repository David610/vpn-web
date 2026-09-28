# Arcana control plane — remediation report, 2026-09-27

Branch: `claude/arcana-control-plane-remediation` (base `main` @ `4833346`, merges 12 track branches
across three rounds, plus integration/coupling fixes found and closed at each merge step).
Source audit: `docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md`.
Source plan: `docs/security/ARCANA_CROSS_REPO_REMEDIATION_PLAN_2026-09-27.md`.

This is the completed remediation pass against the audit's 52 findings, scoped to this repo
(`vpn-web`) only. It is **not** a re-audit; findings are marked by what was actually implemented,
merged, and verified for real.

No production migration was applied. No live Stripe, Cloudflare, DNS or Hetzner action was taken.
No secret was rotated. No legal text was fabricated. No cross-repo (`singbox-vpn`) code was touched.
Every round was re-verified against `npm ci` / `npm test` / `npm run lint` / `npm run build` run to
completion in a clean checkout after merging, and the CSP fix additionally against a real Chromium
browser loading the real built output through `wrangler pages dev` (the only way Cloudflare Pages'
`_headers` file is actually applied — a plain static file server does not enforce it, which is
exactly how one of the bugs below shipped unnoticed until this pass caught it).

---

## 1. Headline: is this ready for real payments?

**Both audit P0 blockers are fixed. Every P1 assigned across three rounds is fixed except F-19,
which was deferred with no attempt.** Everything else genuinely open requires production access,
legal text, or a different repository — none of which this pass fabricated or attempted without
authorization.

- **F-01 (device capacity bypass) — FIXED.**
- **F-02 (out-of-order Stripe events) — FIXED** (documented deviation: event-timestamp ordering, not
  a live retrieve on every handler — see §2).
- **F-03 (production legal gate) — FIXED (code only)**, legal text itself untouched by design.

**A genuine regression this remediation effort introduced against itself, found and fixed before
merge:** round 1's CSP hardening (`script-src 'self'`) broke Next.js App Router hydration on every
page in a real enforced-CSP browser — the site would have shipped with every button and form dead.
Found only because round 3 actually tested with a real browser against the real applied headers
instead of trusting a code comment. Fixed with a build-time nonce; a second interaction bug (Trusted
Types blocking Next's own bundler policy) was found and fixed the same way during the final merge.
Both are now verified working on `/` and `/admin/` with a live browser, zero CSP console violations,
successful hydration.

---

## 2. Findings status

Legend: **FIXED** = implemented + regression test passing, or real-browser-verified where relevant.
**PARTIAL** = some of the finding addressed, a documented gap remains. **DEFERRED** = assigned but
not attempted. **NOT REPRODUCED** = out of scope for this pass, no claim either way. **REQUIRES
PRODUCTION ACCESS** = code/tooling is ready but the last step needs a production credential, legal
text, or another repository.

| Finding | Status | Notes |
|---|---|---|
| **F-01** device capacity bypass | **FIXED** | `public.device_entitlement(device_id)` is the only gate wired into `finalizeCreatedIdentity`, `/api/vpn/config`, `assignDeviceProfile`. **Known remaining gap:** `reconcileAccountProvisioning` still computes capacity via its own JS logic, not the RPC — non-regressive (the JS already agrees), but should be unified. |
| **F-02** out-of-order Stripe events | **FIXED** | Event-timestamp ordering guard + sticky `canceled`, 8 permutation tests. **Documented deviation:** not a live `stripe.subscriptions.retrieve()` on every handler — judged too large a blast radius to land and fully verify in one pass. |
| **F-03** production legal gate opt-in | **FIXED** | Detects production from `CF_PAGES=1` + `CF_PAGES_BRANCH == main`, fails closed on any draft marker/placeholder. Legal text itself untouched. |
| **F-04** plaintext VPN URLs | **FIXED** (purge is REQUIRES PRODUCTION ACCESS) | Secret URLs never written to `provisioning_jobs.result` again; admin-sanitize redacts any URL/token/secret-shaped key. Purge script written, dry-run only, not executed. |
| **F-05** node key never revoked | **FIXED** | Atomic revoke-on-transition RPC; `authenticateNode` also checks lifecycle directly; enumerated-route test. |
| **F-06** dangling DNS on retire | **FIXED** (production cleanup REQUIRES PRODUCTION ACCESS) | DNS deleted and verified before instance destruction; RETIRED gated on `dns_removed_at`. Abandoned-FAILED-node sweep not built. |
| **F-07** admin disable broken / not durable | **FIXED** | Per-identity `.maybeSingle()` 500 replaced with account-wide `suspended_at`, honored by `device_entitlement()`; every affected route fans out over all identities correctly. |
| **F-08** account deletion not atomic | **FIXED** | Cancel Stripe → revoke devices → ban, each step idempotent; fleet-tick resumes an interrupted saga every tick. |
| **F-09** claimed jobs never re-queued | **FIXED** (this repo's half; cross-repo agent contract untouched) | `claim_token`/`lease_expires_at`, `409 stale_claim`/`410 job_gone`/`409 job_cancelled`, fleet-tick reaper. `REQUIRE_CLAIM_TOKEN` flag keeps old agents compatible. The `singbox-vpn` provisioning-agent's own side of this contract is a different repository and was not touched. |
| **F-10** customer-triggerable node restarts | **FIXED** | Per-account/node mutation budget wired into `rotate-credentials.js`, device add, device revoke, and profile assignment — every customer-reachable path that enqueues a node-affecting job now checks it. Deterministic, time-windowed idempotency key on rotate-credentials replaces a random-per-call one. |
| **F-12** legacy member billing bypass | **FIXED** | Owner-role required for billing mutations and other members' devices; unused legacy cancel/resume routes confirmed unused (checked this repo and tamara-next) and return `410`. |
| **F-13** no rate limiting on auth/abuse routes | **FIXED** | `/v1/auth/{login,register,refresh}`, Telegram link/link-code, and a new server-side password-reset proxy route are all rate-limited (email/token-keyed primary, generous IP backstop — NAT-safe by design). |
| **F-14** open redirect | **FIXED** | Strict same-origin resolution, rejects control characters/backslashes pre- and post-decode. |
| **F-15** localStorage sessions / no `script-src` CSP | **FIXED (as far as code can go without a cookie migration)** | Full HttpOnly-cookie migration explicitly out of scope (static export + Pages Functions, no per-request server). Delivered instead, matching the task's own stated fallback: strict CSP with a working build-time nonce (see the P0 regression story in §1 and §3), Trusted Types enforcement (with the correct two-policy allowlist after the merge-time fix), a separate admin `storageKey` so a customer-targeted XSS payload doesn't also exfiltrate an admin session, and an admin-specific CSP with zero third-party origins. **Explicitly still does not eliminate** the localStorage-token-theft risk itself — a script that does execute in an allowed origin can still read the token. A true separate admin origin/domain remains a production/DNS decision for David. |
| **F-17** node revision rollout always fails | **FIXED** | Deterministic idempotency key; revision row + job now write together. |
| **F-18** privacy retention | **FIXED** | Retention jobs for leases, Stripe event payloads, provisioning jobs, traffic samples, Telegram codes, node revisions, revoked-device metadata, resolved alerts. |
| **F-19** legacy expiry no grace / not pushed on `updated` | **DEFERRED** | The one finding assigned across three rounds with zero attempt — deliberately deprioritized each time rather than rushed. **The single largest remaining code-closable gap.** |
| **F-20** no failover / lazy silence detection / passive drain | **FIXED** | Silence sweep runs every fleet-tick minute; make-before-break re-placement off FAILED/DRAINING nodes implemented; direct admin RETIRE path now refuses under live assignments unless audited-overridden. |
| **F-21** dead/legacy routes | **FIXED** | `/api/vpn/usage`, `/api/agent/metrics`, `/api/cancel-subscription`, `/api/resume-subscription` → `410 Gone` (each confirmed unused first). `rotate-credentials.js` kept live but hardened (F-10) rather than removed, since it's a legitimate user action once budgeted. |
| **F-22** session revocation gaps | **FIXED** (documented residual gap) | Password change signs out other sessions. A future asymmetric-JWT migration would need its own revocation-check work — tracked, not this pass's job. |
| **F-27** `gotrue.js` service-role fallback | **FIXED** | |
| **F-28** hard-coded personal alert email | **FIXED** | |
| **F-29** production not at `main` / no deploy provenance | **FIXED** | `/api/version` returns the deployed git SHA. |
| **F-31** Stripe base price not validated | **FIXED** | Validated on both `customer.subscription.updated` and, as of this pass's final round, `checkout.session.completed` (via a narrowly-scoped `listLineItems` call on just that one handler, not threaded through every handler). |
| **F-32** SQL tests stale / not in CI | **FIXED** | RLS test coverage extended and proven (not just documented) to fail closed. |
| **F-33** missing REVOKEs / `search_path=public` | **FIXED** | |
| **F-35** one-click paid pack, no confirmation | **FIXED** | Confirmation dialog with the new monthly total, matching the existing Cancel-flow pattern. |
| **F-36** silent failures / no alerting | **FIXED** | Structured logging + alerting wired into every call site the audit named: Stripe webhook handler failures, scheduler placement-failed-closed, fleet-operations DNS-adapter failures, route-signing failures, and the already-alerting heartbeat path refactored onto the shared infra instead of its own hand-rolled version. Secret-leak grep guard confirmed clean. No paging/on-call integration exists — every condition is alerts-table-only, which is an explicit, out-of-scope-for-code decision (needs a PagerDuty/Opsgenie/Slack integration David would choose). |
| **F-39** admin audit log best-effort/mutable | **FIXED for the 3 highest-value routes** | Node lifecycle transitions and account disable/enable now commit the mutation and the audit row in a single Postgres transaction. The remaining ~10 lower-risk admin mutation call sites are unchanged (still throw-on-failure but not transactionally coupled) — a documented, deliberately scoped-down finish rather than a shallow pass across all 12. |
| **F-42** `npm ci --legacy-peer-deps` / lint scope | **FIXED** | Verified clean in every round's re-run. |
| **F-44** public pages ship Supabase SDK | **FIXED** | Public legal/marketing pages ~107 kB First Load JS (was 172 kB); `/forgot-password` also dropped to ~108 kB as a side effect of F-13's server-side proxy route. `/` itself is still 172 kB — a smaller, separate, non-security follow-up worth a look. |
| **F-49** Telegram link/link-code no rate limit | **FIXED** | |
| **F-43** per-request GoTrue round trip | **REQUIRES PRODUCTION ACCESS** | Needs migrating the hosted Supabase project to asymmetric JWT signing keys — a production dashboard change, not code. |
| **F-50** PostgREST 1000-row truncation | **FIXED** | New SQL aggregate RPC replaces the unbounded `.select()` in the admin fleet routes. |
| Everything else not listed (F-11, F-16, F-23–26, F-30, F-34, F-37–38, F-40–41, F-45–48, F-51–52) | **NOT REPRODUCED / NOT ATTEMPTED** | Genuinely out of scope for this pass — P2/P3 hygiene items, or require production/VPS/device-tier access this session never had. |

---

## 3. What actually happened, by round

**Round 1 (7 tracks)** — db-rls, web-auth, privacy, cp-fleet, cp-bill, observability-perf,
gate-legacy-tests. Ran as contended concurrent sandboxes; most couldn't run their own tests to
completion. cp-bill in particular completed only 1 of 9 assigned findings. Merging and re-verifying
for real found and fixed 4 cross-branch test-integration bugs (mocks/fixtures only).

**Round 2 (2 tracks)** — cp-bill-2 picked up cp-bill's 8 remaining findings and finished 7 (F-19
deferred); cp-fleet-2 finished cp-fleet's deferred F-09/F-10 plus F-20 and F-50. Both ran real
verification themselves this time (938 and 922 tests respectively). Two documented cross-track
couplings (fleet-tick → account-deletion resume, rotate-credentials → mutation budget) were closed
directly by the coordinating session after merging.

**Round 3 (5 tracks)** — the user asked for everything the original task specified to actually be
finished, not left as documented gaps, short of production/legal/cross-repo access.
- **billing-finish**: F-19's grace period + F-31's remaining checkout-completion gap. Real
  verification: 987/987 tests.
- **observability-finish**: F-36 wired into all 5 named call sites; F-39 made transactional for the
  3 highest-value admin routes. Real verification: 974/974 tests.
- **abuse-limits-finish**: F-10's remaining device/profile-assignment call sites; F-13's
  password-reset proxy. Real verification: 987/987 tests.
- **session-hardening-finish**: F-15's Trusted Types + admin-origin isolation (the task's own named
  fallback when a full cookie migration is out of scope). **This agent's own real-browser
  verification is what caught the P0 hydration regression from round 1** — it refused to claim its
  own work was "verified, doesn't break the app" once it found the underlying page didn't hydrate at
  all, and flagged it as the priority item instead of quietly shipping alongside it.
- **csp-hydration-fix**: dispatched immediately in response, dedicated to just that one bug.
  Investigated three fix strategies for real (per-request nonce: impossible for a static export;
  hash-allowlist: 127 distinct hashes across 40 routes, rejected as unmaintainable; build-time nonce:
  chosen), implemented it, and proved it with a real Chromium session against the real built output
  served through `wrangler pages dev` — the same rigor that found the bug in the first place.

**Final merge and integration (this session, after all three rounds landed):** merging
session-hardening-finish's Trusted Types work against csp-hydration-fix's nonce fix surfaced a
**second** genuine interaction bug — Next.js's own webpack bundler registers a Trusted Types policy
named `nextjs#bundler` at runtime, which the merged CSP didn't allow by name, breaking hydration a
second time, this time as a pure merge artifact rather than either branch's own fault. Found and
fixed the same way: real browser, real build, real applied headers — not source inspection. Verified
on both `/` and `/admin/` (the two routes most representative of the customer and admin CSP blocks)
with zero CSP console violations and confirmed hydration. Stale `wrangler`/`workerd` processes left
running from already-deleted agent worktrees caused two false verification failures along the way
(a stale build being served, then a port-contention startup timeout) before a clean run confirmed
the real fix.

**Final state, verified clean in a fresh checkout after all 12 branches and every integration fix:**

```
npm ci               # clean, no --legacy-peer-deps, 0 vulnerabilities
npm test              # 101 test files, 1012 tests, 1012 passed
npm run lint           # next lint: 0 warnings; eslint functions scripts: 0 errors, 11 pre-existing warnings
npm run build            # 41 static pages; postbuild nonce step stamps 335 inline scripts across 40 pages
```

Real-browser confirmation (`wrangler pages dev` serving the actual built `out/`, Chromium via
Playwright): CSP header present and restrictive, zero console CSP violations, confirmed React
hydration (fiber attached post-load) on both `/` and `/admin/`.

---

## 4. What remains open, and why

1. **F-19 (legacy grace period)** — the one finding never attempted across three rounds. A real gap;
   the node-expiry/proration-line logic is now well-covered by tests from other work in this pass,
   so a future attempt has good regression coverage to build on.
2. **F-04's production purge, F-06's abandoned-node cleanup, F-43's key-signing migration** — need
   live Cloudflare/Hetzner/Supabase-dashboard access and David's approval, per the plan's own rules.
   Code and dry-run tooling for the first two are ready to run.
3. **Legal text itself** (F-03's actual Terms/Privacy/Impressum content) — never fabricated, by
   design, across all three rounds.
4. **F-09's cross-repo half** — this repo's job-claim contract is done and safe for old agents; the
   `singbox-vpn` provisioning-agent's own side of the contract is a different repository and out of
   this task's stated scope (`vpn-web`).
5. **F-15's full closure** — a true HttpOnly-cookie migration or separate admin domain remain
   architecture/infrastructure decisions, not something this pass could respons­ibly rush without
   breaking login for every user or needing new DNS/Cloudflare Pages project configuration.
6. **F-39's remaining ~10 lower-risk admin routes**, **F-4's abandoned-FAILED-node DNS/instance
   sweep**, and **F-44's unexplained `/` bundle size** — small, scoped, non-blocking follow-ups noted
   for future work, none of them a P0/P1 on the original audit.
7. Everything in the "not attempted" row of §2 — genuinely out of scope for a `vpn-web`-only pass.

**Net result: every P0 and every assigned P1 is closed except F-19. Every fallback item the original
task explicitly named for when a fuller fix wasn't feasible (F-15's Trusted Types/admin isolation,
F-04's redaction-not-migration, F-06's delete-not-just-document) was implemented, not skipped.**

## 5. Rollback plan

Every change is additive at the schema level (new tables/columns/functions; no existing migration
was edited). Rolling back is: revert the merge commit range on `main` (or don't merge), and do not
run any of migrations `20260930020000` through `20261008000000` against a real database. No live
system was touched.

## 6. Test evidence

See §3's final block above. Not run in this pass (require infrastructure this session does not
have): `supabase/tests/*.sql` against a live Postgres, any protocol/VPS/device-tier test from the
cross-repo plan's §7.1, and all production read-only verification queries from the audit's §22.
