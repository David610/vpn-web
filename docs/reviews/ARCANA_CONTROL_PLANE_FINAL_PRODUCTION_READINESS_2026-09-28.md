# Arcana control plane — final production readiness (2026-09-28)

Deployed/tested SHA: `039197c669f1e8d666a6bbeb322e576a58714cf1` (branch
`claude/nice-volta-cb47e7`, 24 commits on top of `main` = `4dcc6f8`, the
commit this remediation started from).

This document supersedes the finding-table status in
`docs/reviews/ARCANA_CONTROL_PLANE_REMEDIATION_2026-09-27.md` where the two
disagree; that document's own round-3 narrative was right about F-19, its
table was wrong. Do not read this document as "ready to take payments" —
see §5 for exactly what still blocks that, and §7 for what nobody in this
session could verify at all.

Status legend: **FIXED** (verified by code read + passing test, on this
exact branch, by more than one person/agent this session), **PARTIAL**
(some of it verified, a real gap remains, described), **UNVERIFIED**
(genuinely not checked — either no live access, or out of this session's
scope), **EXTERNAL BLOCKER** (not code-fixable — needs a human decision,
real infrastructure, or content only the business can supply),
**PRODUCTION APPROVAL REQUIRED** (code/tooling is ready; the action itself
is a live mutation and must not run without the user's explicit go-ahead
per this remediation's own Phase 17 gate).

---

## 1. What this session actually did

Re-audited the prior remediation's claims against current code (not
against either document's own summary), fixed what was found broken, and
extended coverage. All work landed as 24 commits on `claude/nice-volta-cb47e7`,
each independently green (`npm test`/`npm run lint`/`npm run build`/SQL
suite) before merge into the reconciled head, and the reconciled head was
independently re-verified from a clean `rm -rf node_modules out && npm ci`
multiple times during the session, most recently right before this
document was written:

- `npm test`: **1070/1070 passing**, 106 files
- `npm run lint`: **0 errors**, 11 pre-existing unused-var warnings (unchanged all session)
- `npm run build`: clean, 41 static pages
- SQL suite (`scripts/test-supabase-sql.sh` against a real local PostgreSQL 16, all 51 migrations replayed from empty): **5/5 test files passing**, run 3× in a row with no flakiness
- Secret scanner (`scripts/check-log-secrets.mjs`): clean, 232 files
- `/api/version`: confirmed exposes the exact `CF_PAGES_COMMIT_SHA` Cloudflare Pages sets at build time, plus a schema-drift smoke check

No production data was touched. No live Stripe/Supabase/Cloudflare/Hetzner
mutation was made — confirmed there are **no production credentials of any
kind in this environment** (every `SUPABASE_*`/`STRIPE_*`/`CLOUDFLARE_*`/
`HETZNER_*`/`TELEGRAM_*`/`RESEND_*` env var was unset throughout).

---

## 2. Schema / migration state

51 migrations, all additive, all replay cleanly from empty. 8 new migrations
this session (none edit an existing one, per instruction):

- `20261002000000_device_entitlement_assignment_order.sql` — fixes a real non-determinism bug (below)
- `20261002000001_revoke_dead_account_member_grants.sql` — fixes a real RLS-test gap (below)
- `20261007000000_job_claim_tokens.sql`, `20261007010000_device_node_assignment_counts.sql`, `20261008000000_admin_audit_transactional.sql` — pre-existing on the branch at session start, re-verified not authored this session, listed for completeness
- `20261009000000_past_due_grace.sql` — F-40 bounded past_due entitlement
- `20261010000000_admin_audit_transactional_round2.sql` — remaining admin-mutation audit atomicity
- `20261011000000_node_cleanup.sql` — abandoned-node cleanup saga state

RLS: all public tables have RLS enabled, 0 without. anon/authenticated
grants are SELECT-only on 8 tables (profiles, subscriptions, vpn_accounts,
devices, connection_profiles, device_profile_assignments, locations,
telegram_links) — matches what the original audit documented as
intentional, with one correction (below). SECURITY DEFINER functions all
use `search_path=''` except `check_rate_limit` (`search_path=public`,
service_role-only, returns only a boolean, documented inline as
intentional). No genuine unfixed gap found in a fresh re-verification pass
(§6, Phase 13).

---

## 3. P0/P1 findings — corrected final status

### F-01 — device capacity bypass — **FIXED, with a real bug found and fixed in the fix itself**
The original P0 (JS computed capacity independently of the DB) was already
closed on entry to this session via `public.device_entitlement()`. This
session found the fix itself was broken: capacity ranking used
`(subscription_assigned_at, id)`, and `subscription_assigned_at` defaults
to `now()`, which Postgres freezes for an entire transaction — any batch
insert of multiple devices in one transaction got identical timestamps and
fell back to random UUID tie-breaking, non-deterministically admitting the
wrong device past the paid cap. Reproduced: `device_entitlement_test.sql`
failed 2 of 3 runs before the fix. Fixed with a sequence-backed ordinal
(`subscription_assignment_seq`, set via `nextval()`, which is never
transactional) in `20261002000000_device_entitlement_assignment_order.sql`.
5/5 repeated SQL runs clean after the fix.

### Phase 3 (C-01) — unify JS/SQL entitlement logic — **FIXED**
`subscriptions.js`'s `resolveDeviceEntitlements`/`loadDeviceEntitlements`
(a second, independently-maintained JS re-implementation of the SQL
capacity rule) deleted entirely. `reconcileAccountProvisioning`,
`/v1/vpn/authorize`, `/v1/entitlement`, `assignDeviceProfile`,
`finalizeCreatedIdentity`, `/api/vpn/config` all now decide entitlement
solely via `public.device_entitlement()`. New regression tests prove an
unentitled 4th device gets no `CREATE_USER`, no profile assignment, no
authorization, on a suspended account too.

**Flagged, not fixed**: `seat-constants.js`'s display-only
`deviceCapacity()` formula diverges from the SQL formula for
non-multiple-of-3 `extra_seats` (only reachable via a manual Stripe
dashboard edit, not any live write path). Needs a product decision on
which formula is canonical before touching either side.

### F-02 — out-of-order Stripe webhooks — **FIXED** (pre-existing on branch entry, re-verified)
`isStaleSubscriptionWrite`, sticky `canceled`, monotonic
`stripe_synced_at` guard. Documented deviation from the audit's suggested
ideal fix (event-timestamp ordering instead of a live
`stripe.subscriptions.retrieve()` per handler) — acceptable, documented in
the remediation report.

### F-03 — legal deploy gate — **PARTIAL / EXTERNAL BLOCKER**
The gate itself (code that refuses a production build if legal pages still
carry placeholder markers) is implemented and was not touched this
session. **The legal content itself is still a placeholder** — confirmed
directly this session: `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`,
and `src/app/impressum/page.tsx` all still contain `TODO (legal review
needed)` markers, and impressum still has literal
`[Company or sole-proprietor legal name]`. **This is a hard release
blocker.** No AI-generated legal text was written to close this, per
explicit instruction not to fabricate a German Impressum or any legal
content. **Someone with actual company/business information must supply
real Terms, Privacy Policy, and Impressum text before this can go live.**

### F-04 — plaintext setup URLs — **PARTIAL: code fixed, production purge UNVERIFIED/PRODUCTION APPROVAL REQUIRED**
Code no longer writes plaintext URLs into `provisioning_jobs.result`
(pre-existing fix, re-verified). The purge tool
(`scripts/purge-plaintext-urls.mjs`) had a real idempotency bug fixed this
session (the sensitive-key regex matched its own `*_reported` marker,
so re-running it on an already-cleaned row un-did its own marker and would
never converge) and gained explicit `--dry-run`-default/`--live`,
age-bucket reporting (counts only, never contents), resume-safe batching,
and a post-clean verification pass. Tested against synthetic local data:
dry-run mutates nothing and reports correctly; live mode purges and
verification confirms zero remaining. **Never run against production this
session — no production credentials exist here, and even with them this
is a live data mutation requiring the user's explicit approval per the
Phase 17 gate.** Change-set for that approval: WHAT — delete/redact
plaintext-URL-shaped keys from historical `provisioning_jobs.result` rows;
WHY — F-04 closure, defense in depth (AES-GCM encryption elsewhere is
otherwise defeated by these rows); COMMAND — `node scripts/purge-plaintext-urls.mjs --live` (after a `--dry-run` review of the count/age report); ROLLBACK — none once run (this is a redaction, not reversible; take a backup first); EXPECTED DOWNTIME — none (targeted row updates, batched); DATA IMPACT — removes plaintext URL strings from historical job-result JSON, does not touch `vpn_secrets` (the encrypted store) or any live credential; SECURITY IMPACT — strictly positive (closes a defense-in-depth gap), no negative impact.

### F-05 — node key revocation — **FIXED**, re-verified twice this session
`node-auth.js` rejects both `revoked_at` set and `lifecycle_state IN
(QUARANTINED, RETIRED)` independently (defense in depth).
`revoke_node_key_and_transition()` couples the revoke with the lifecycle
transition, job cancellation, lease-slot deletion, and audit insert in one
transaction.

### F-06 — dangling DNS on retire — **FIXED**, re-verified twice this session
Retire path deletes the DNS record, verifies via `recordExists`
(Cloudflare eventual-consistency check), sets `dns_removed_at`, only then
transitions to RETIRED — in that order specifically to prevent subdomain
takeover.

### New this session — abandoned FAILED-node cleanup — **FIXED**
No cleanup previously existed for FAILED/RETIRED nodes' servers and DNS
(the original audit called this out: "kept for inspection" = leaked cost +
attack surface). Built as a `fleet_operations`/`operation_steps` saga
(reusing the existing engine, not a new mechanism): `VERIFY_ELIGIBLE`
(hard safety precondition — a node with ANY live `device_node_assignments`
is never touched, regardless of health) → `REMOVE_DNS` → `REVOKE_AND_RETIRE`
→ `DESTROY_INSTANCE`. Has a true dry-run mode (zero writes, guaranteed by
code path) and an operator CLI (`scripts/cleanup-abandoned-nodes.mjs`).
14 tests cover: live-assignment node never destroyed even if FAILED+stale;
idempotent re-run; retry-safe resume after a partial failure. **Never run
against production or real infrastructure this session** — same
Phase-17-gate rule as F-04's purge.

### F-07 — admin disable/suspend — **FIXED**
Account-level `suspended_at`, honored directly by `device_entitlement()`
(`account_suspended` reason) — fixes the original bug (broken for any
customer with more than one VPN identity, and reconcile silently
re-enabling what admin disabled).

### F-08 — account deletion atomicity — **UNVERIFIED this session**
Not independently re-traced. The prior remediation claimed this fixed
(Stripe-cancel → revoke → ban ordering with fleet-tick resume); this
session did not re-derive it from code. **Recommend a dedicated read of
`account-service.js`'s deletion path before trusting this claim fully** —
it was verified by a background agent's grep-level check only, not a full
trace with tests, unlike everything marked FIXED above.

### F-09 — job claim/lease/reap contract — **PARTIAL: vpn-web side FIXED, cross-repo NOT closed**
vpn-web's contract (`claim_token`, `lease_expires_at`, `reap_expired_job_claims`
run every minute from fleet-tick, `validateJobClaim` rejecting stale/
cancelled/foreign claims) is correctly implemented and has full lifecycle
regression coverage added this session (9 new tests: crash→lease-expiry→
reap→reclaim→old-agent's-late-report-rejected; cancelled-job rejection;
duplicate-completion idempotency; attempts-cap→permanent-failed).

**Cannot be called closed system-wide.** Read directly from
`David610/singbox-vpn`'s current default branch (`927d9e6`, cloned
read-only this session, checked ~100 remote branches too — no branch
anywhere implements the token contract): the Rust agent's `Job` struct
has no `claim_token`/`lease_expires_at` fields at all, and `complete()`/
`fail()` never echo a token back. Today's transitional
`REQUIRE_CLAIM_TOKEN=false` default means the server currently accepts a
tokenless report as long as `status==='claimed'` — and a new regression
test this session proves that check alone is insufficient: it does not
distinguish an old, superseded claim from a fresh reclaim once both share
`status='claimed'`. **This is a real, exploitable-by-crash race today**,
contained only by the fact that reaping is server-side and the window is
narrow. Closing F-09 requires two changes in `singbox-vpn` (documented
with exact file:line by this session's agent, not fixable from vpn-web):
add and echo `claim_token`/`lease_expires_at` in `worker_client.rs`, and
stop indefinitely retrying on 404/409/410 in `main.rs`'s report loops.
Then flip `REQUIRE_CLAIM_TOKEN=true` in vpn-web once the fleet is upgraded.
**EXTERNAL BLOCKER** — out of this repository's scope to close alone.

### Protocol health / silence detection (Phase 6) — **FIXED** (pre-existing on branch entry, re-verified against real singbox-vpn code)
Read the actual current `singbox-vpn` agent (`protocol_probe.rs`,
`health_probe.rs`) to confirm what it can really report — REALITY/Hysteria2
handshake, DNS, egress, cert-days, latency/loss — and confirmed vpn-web's
`protocol-health.js` only validates dimensions the agent actually emits (no
invented capability). READY requires more than a heartbeat: DEGRADED→READY
is blocked unless the protocol-probe failure counter is zero, independent
of Clash-probe health. Silence detection runs unconditionally every minute
from fleet-tick (not lazily, as the original audit found) — confirmed by a
passing test asserting this.

### Failover (Phase 7) — **FIXED**, including one real gap found and fixed
Scheduler/route-candidates/route-directory all filter to
`READY`/`CANARY` lifecycle states — a DEGRADED/FAILED node is never a new
candidate on any code path, with no caching to go stale. The strict 2-hop
invariant is fail-closed by construction (`scheduleDoubleHopForDevice`
never persists a partial placement). **Gap found this session**: existing
DOUBLE_HOP-device failover (`reconcileFailedNodeAssignments`) only ever
scanned `hop='EXIT'` assignments — a DOUBLE_HOP device whose RELAY node
failed was never reconciled, silently stranded forever even though its
EXIT hop looked healthy. Fixed: `pickReplacementNode` now matches both the
failed node's role AND its `location_id` (this is what keeps the device's
scheduled entry/exit location pairing valid across a failover without
re-deriving it from `allowed_paths` — only the physical node filling a
hop's slot changes), and both `hop='EXIT'` and `hop='RELAY'` are scanned.
8 new tests, including one proving a same-role wrong-location node is
never picked.

### F-15 — admin session security — **PARTIAL, documented residual risk + one real bug found and fixed**
A full httpOnly-cookie migration for admin sessions was assessed as
disproportionate given this app's static-export + Pages-Functions-only
architecture (no server-render path to gate `/admin/*` on a cookie before
client JS loads) — write-up in `docs/security/ADMIN_SESSION_SECURITY_ASSESSMENT.md`
proposes the real fix (a separate `admin.<domain>` origin or moving admin
off static export) as a **PRODUCTION APPROVAL REQUIRED** infrastructure
decision, not implemented. What's real today: a distinct localStorage key
for admin vs. customer sessions, and a strict independent CSP + Trusted
Types policy on `/admin`/`/admin/*` — re-verified this session, and one
genuine bug found and fixed in that verification: `/admin`'s CSP rule
never issued the `! Content-Security-Policy` unset Cloudflare Pages
`_headers` needs before setting its own policy, so it was being
concatenated onto the site-wide default instead of replacing it
(`/telegram` already did this correctly; `/admin` didn't). Currently
harmless in content (identical policy text, so functionally inert), but
structurally not actually an override — fixed, confirmed via a manual
`wrangler pages dev` + `curl` check that `/admin` now serves a single
clean policy. **Residual risk stands as documented**: same-origin XSS can
still read the admin token directly; there is no true origin isolation.

### Admin audit atomicity (Phase 10) — **FIXED**
Extended the existing pattern (mutation + `admin_audit_log` insert in one
transaction) to the remaining routes: billing/entitlement grant and
revoke, credential/subscription-token rotation job fan-out, and the
plain-UPDATE node-lifecycle path (the QUARANTINED/RETIRED path was already
atomic). Tests simulate an RPC failure and assert neither the mutation nor
the audit record persists — no split-brain state. Explicitly left outside
this pattern (documented, lower-stakes): abuse/alert triage, job retry,
and `replace.js`'s multi-step saga (owned by the node-lifecycle
engine, which already has its own audit trail via `operation_steps`).

### Privacy retention (Phase 11) — **FIXED**
The retention functions already existed and correctly covered every
flagged table (bounded, safe, never touches live/claimed/open rows,
reports row counts only). The real gap — nothing actually scheduled it to
run — is fixed: `scripts/setup-retention-cron.mjs` installs a daily
pg_cron job, same pattern as fleet-tick's.

### Observability (Phase 15) — **PARTIAL, external blocker for the rest**
Most flagged failure signals already write an `operational_alerts` row.
Added a generic `dispatchAlert()` adapter seam (one email adapter shipped,
critical-only) so wiring a real external destination later is a small
follow-up per call site, not a rewrite — deliberately did not choose or
hard-code a paging vendor (Slack/PagerDuty/etc.), since that's the user's
infrastructure decision. **Three signals still write no alert row at
all**: entitlement inconsistency, backup/restore failure, rate-limit
anomaly — flagged rather than guessed at thresholds. **Every alert kind
except job-permanently-failed still has zero delivery path beyond the
dashboard** even after this session's seam, since nothing yet passes an
`env` into most `raiseAlert()` call sites — wiring each is now a one-line
follow-up per file. **EXTERNAL BLOCKER**: no paging vendor has been chosen.

### Performance (Phase 16) — **FIXED where real, correctly left alone where not**
Frontend: the audit's flagged issue (Supabase SDK loading on every public
page) was already fixed before this session (localStorage read, no SDK
instantiation, on `/`, `/pricing`, `/locations`, legal pages). Backend,
profiled against a local Postgres seeded with 2,000 accounts / 6,000
devices / 40,000 traffic samples: `device_entitlement()` — 3.5ms/call,
fine at scale, no change needed. `/v1/routes` — confirmed unfixed (4
queries + a signature per request, no caching); fixed with a 30s
module-scope cache of the signed envelope. Heartbeat — confirmed a
genuine O(N²) redundancy (a full silence-scan ran on every single
heartbeat, on top of fleet-tick's own unconditional per-minute sweep
already doing the same job); removed the redundant per-heartbeat scan.
`reconcileAccountProvisioning`'s N+1 — confirmed real but bounded (≤60
devices/account) and latency-bound rather than compute-bound; correctly
NOT "fixed" with a speculative rewrite — flagged as a future dedicated
pass if production telemetry ever shows it's actually a problem.
PostgREST's 1000-row admin-aggregate truncation risk (F-50) — confirmed
already fixed (aggregate RPCs + explicit `.limit()`/`.range()` everywhere
checked).

### SQL/RLS gap found this session (F-32 area) — **FIXED**
`supabase/tests/rls_test.sql` failed deterministically with "permission
denied for table account_members" on devices/connection_profiles/
device_profile_assignments — not a missing grant, but a **dead, unusable
one**: `authenticated` had a live SELECT grant on these three tables whose
RLS policy sub-selected the unreadable `account_members` table, so any
query errored out mid-policy instead of failing cleanly. No application
code reads these tables directly (server always uses service_role,
confirmed by the original audit's own section 6.3). Fixed by revoking the
dead grant (`20261002000001_revoke_dead_account_member_grants.sql`) —
fails closed at the grant level now, exactly like every other table with
no direct-client-read contract, rather than depending on a confusing
cross-table error. Test updated to assert the correct fail-closed shape.
The remediation report's prior claim that this file was "proven to fail
closed" was **not accurate** as committed — now it genuinely is, verified
5/5 across repeated runs.

---

## 4. F-19 (the document's own contradiction) — resolved definitively

**F-19 is FIXED.** The remediation report's finding *table* said DEFERRED;
its own round-3 *narrative* said implemented; this session traced the
actual code, twice, independently, with comprehensive new test coverage,
and confirms the narrative was right:

- 72h grace (`LEGACY_NODE_EXPIRY_GRACE_MS`, `functions/lib/stripe-fields.js`)
  applies ONLY to the node-facing `serviceExpiresAt`/job `expires_at`,
  never to the customer-visible `currentPeriodEnd` — explicitly tested.
- The proration-line-first bug (`getInvoiceLinePeriodEnd` used to take
  `lines.data[0]` instead of the max across every invoice line) is fixed.
- `customer.subscription.updated` now also pushes a renewed expiry when
  the period genuinely advances, not only `invoice.paid`.
- Terminal states (`canceled`/`unpaid`) cut service immediately, with NO
  grace — re-derived from code, not assumed, this session.
- New tests cover every scenario the user asked for: delayed webhook,
  duplicate webhook, reordered/stale webhook, multiple invoice line items,
  payment recovery, `cancel_at_period_end`.

**F-40 (the adjacent gap F-19's fix surfaced): past_due was live
forever.** Fixed with an explicit, bounded 14-day grace window — chosen
because Stripe's default Smart Retries dunning schedule runs for roughly
two weeks before giving up, so 14 days covers a legitimately temporary
card problem without granting indefinite free service. Implemented
identically in both JS (`subscriptions.js`'s `isLive()`, `accounts.js`'s
`getLiveSubscription()`) and SQL (`device_entitlement()`, re-created in
`20261009000000_past_due_grace.sql`) so there is one bounded rule, not two
that could drift. A new `past_due_since` column tracks the transition
timestamp; missing/legacy values fail OPEN (still live), matching the
existing `isStaleSubscriptionWrite` precedent for how this codebase
handles ambiguous legacy state. Recovery within or after the window fully
restores entitlement (this bounds unpaid risk, it does not punish a late
successful payment).

---

## 5. What blocks calling this "ready for payments" today

In priority order:

1. **Legal content (F-03).** Terms, Privacy, Impressum are still drafts
   with TODO markers and a literal placeholder company name. This is not
   code-fixable. **Someone with real business/legal information must
   supply the actual text.**
2. **F-09 cross-repo.** The reclaim-safety guarantee this session proved
   necessary (a stale/superseded job report can land on a reclaimed job)
   is not yet closed on the `singbox-vpn` agent side. Needs code changes
   in that repository (documented file:line) and a fleet-wide agent
   upgrade before `REQUIRE_CLAIM_TOKEN=true` can be safely flipped.
3. **No paging destination chosen.** Alerts exist in the database and (for
   job failures) email one address; nothing pages anyone for the other
   signals, and 3 signals don't even write a row yet. This needs the
   user's infrastructure decision (Slack/PagerDuty/Opsgenie/etc.), not
   more code.
4. **Backup/restore has never been run.** A runbook exists now
   (`docs/runbooks/BACKUP_RESTORE_AND_SECRET_ROTATION_RUNBOOK.md`) with an
   explicit UNVERIFIED results table — this session had zero production
   credentials to actually perform the drill. It must be run for real,
   once, by someone with Supabase/Cloudflare access, before RTO/RPO claims
   mean anything.
5. **F-04's historical purge and the abandoned-node cleanup are built and
   tested but never run against production** — both are
   PRODUCTION APPROVAL REQUIRED actions per the change-sets in §3/§7.
6. **F-08 (account deletion atomicity) was not independently re-verified
   this session** — recommend a dedicated pass before trusting it fully.
7. **F-15's residual risk is accepted, not eliminated** — same-origin XSS
   can still read the admin token. A true fix (separate admin origin) is
   a proposed, unapproved infrastructure change.

Nothing above is "the code is broken." Everything above is either content
only the business can supply, a decision only the user can make, or a
verified-but-never-executed action correctly withheld pending approval.

---

## 6. Migration security / SQL re-verification (Phase 13)

Fresh replay of all 51 committed migrations on local Postgres 16 with
Supabase-shaped roles: clean. RLS enabled on every table, no unintentional
anon/authenticated grants beyond the 8 SELECT-only tables the original
audit documented (plus the F-01/F-32 fix above). SECURITY DEFINER
`search_path` locked down except the one documented exception. Foreign
keys/constraints intact. No genuine unfixed gap found beyond what's listed
in §3. (Noted but not acted on: a handful of low-cardinality admin/audit
FK columns without a covering index — cosmetic, not correctness/security,
left alone to avoid scope creep.)

---

## 7. Explicitly UNVERIFIED — needs production access this session never had

Confirmed by an empty environment (no `SUPABASE_*`/`STRIPE_*`/
`CLOUDFLARE_*`/`HETZNER_*`/`TELEGRAM_*`/`RESEND_*` credentials anywhere in
this container):

- Production Supabase migration state, JWT signing key type (HS256 vs.
  asymmetric — F-43's proposed migration was not re-assessed this
  session; still needs a plan + rollback runbook + explicit approval if
  still on legacy HS256), auth settings, and actual RLS/grant exposure on
  the LIVE hosted project (as opposed to a locally-replayed equivalent,
  which this session verified extensively).
- Stripe live/test mode configuration, live price IDs, webhook endpoint
  event subscriptions, portal configuration, dunning settings.
- Cloudflare Pages environment variables, DNS zone state, whether any
  retired node's DNS record is still dangling from before F-06's fix
  landed in production.
- Hetzner account state (orphaned instances from before this session's
  cleanup mechanism existed).
- Telegram bot configuration.
- The actual backup/restore drill (§5, item 4).
- Whether the deployed frontend at any live URL matches this SHA (the
  original audit found production was running an OLDER build than `main`
  at the time — this session cannot check whether that's still true).

None of this was assumed fine. All of it needs a human with real
dashboard/API access to check, using the exact read-only queries the
original 2026-09-27 audit's section 22 already wrote out, or newer
equivalents if schema has since moved.

---

## 8. Validation record (for the Phase 17 gate, when it's time)

```
npm ci                                   clean, 0 vulnerabilities
npm test                                 1070/1070 passing, 106 files
npm run lint                             0 errors, 11 pre-existing warnings
npm run build                            clean, 41 static pages
scripts/test-supabase-sql.sh (local PG16) 5/5 files, 3x repeated, no flakiness
scripts/check-log-secrets.mjs            clean, 232 files
CSP header check (manual wrangler+curl)  /admin serves one clean policy (fixed a real bug)
git rev-parse HEAD                       039197c669f1e8d666a6bbeb322e576a58714cf1
```

Not run this session (environment limitation, not skipped by choice):
`scripts/verify-csp-hydration.mjs` and `scripts/trusted-types-check.mjs`
as standalone harness scripts have a `child_process.spawn` environment
quirk in this container (fail identically whether or not the CSP fix
above was applied, only when `npx wrangler` is launched via raw `spawn()`
rather than a shell) — the underlying claim they check was verified
directly instead, by hand-starting `wrangler pages dev` and `curl`-ing the
actual response headers.

---

## 9. Bottom line

The code in this branch is materially more correct and better-tested than
either the original audit or the prior remediation report's own summary
claimed — several "FIXED" claims from the prior round were re-verified and
held up, two were found to be subtly broken and are now genuinely fixed
(F-01's non-determinism, the RLS test's dead grant), and one prior "not
yet done" (F-19) was confirmed actually done, with its own adjacent gap
(F-40) found and closed too. This is not, and should not be called,
"ready for payments" until: real legal content exists, the cross-repo
F-09 gap closes, a paging destination is chosen, the backup/restore drill
is actually run once, and the two prepared-but-unrun production actions
(F-04's purge, abandoned-node cleanup) get explicit approval and execution
against the real environment this session never had access to.
