# Arcana pre-live code freeze — 2026-10-04

Final coding and remediation pass before real-world qualification (VPSs,
Windows, iPhone, Cloudflare, Supabase, Stripe). This is not the live
qualification and does not replace it.

## 1. Repository state

| Repo | `main` at start | `main` now | PR | State |
|---|---|---|---|---|
| tamara-next | `e67c89ed` | `127b554d` | [#42](https://github.com/David610/tamara-next/pull/42) | merged, all 4 CI jobs green |
| singbox-vpn | `a410b99b` | `a410b99b` | [#134](https://github.com/David610/singbox-vpn/pull/134) | **open**, all CI + Security checks green, merge awaiting owner approval |
| vpn-web | `27e85d3a` | `27e85d3a` | this PR | **open** (this report, contract wording, `.gitattributes`) |

The start SHAs matched the heads recorded before the session. Open PRs at start:
only the three Dependabot PRs (#120–#122) in singbox-vpn, deliberately untouched.

singbox-vpn #134 and this PR are docs-only (contract copy, report) plus a
two-line `.gitattributes`. Neither changes runtime behaviour. The merge of #134 was
declined by the session's permission classifier ("merge without review"), so it is
left for the owner. After both merge, the three product contracts are
byte-identical (see section 6).

## 2. Code defects found and fixed

All in tamara-next unless stated.

| # | Defect | Fix |
|---|---|---|
| 1 | `ArcanaConnectionState.authorizing` was unobservable: `ManagedConnectionService` had no stream and never published the phase before `/v1/vpn/authorize`. | `snapshots` stream on the service; coordinator re-publishes every change; `authorizing` spans entitlement, route loading and authorize; `connecting` is published only just before each dial. |
| 2 | After sign-out `connection.phase` stayed `ready` over a signed-out account. | Service `markSignedOut()`; coordinator suppresses intermediate publishes during sign-out. |
| 3 | A cancelled attempt kept reading as in-flight until teardown finished. | `disconnect()` publishes its idle phase as soon as teardown starts. |
| 4 | Authorization expiry could publish over a newer operation. | Generation check before the final publish. |
| 5 | The Locations lock used a phase helper that did not know about `authorizing` (latent, would have appeared with fix 1). | Moved to `ArcanaConnectionState`. |
| 6 | Connection details, diagnostics, signed-in-offline and the status label decided connection truth from the raw phase or engine state. Details would show "Connected" over a dead tunnel. | All read `ArcanaConnectionState` via the mapper (new `ArcanaConnectionBuilder` for widgets). |
| 7 | Product contract copies had drifted (vpn-web had a newer Links `privacy_plus` note). | Synced. The note named third-party client formats, which tamara-next's provenance gate forbids, so the wording now refers to `ARCANA_LINKS_V1.md`. The gate was not weakened. |
| 8 | vpn-web golden fixtures check out as CRLF on Windows (`core.autocrlf`), failing a byte-exact test. Windows-only. | `.gitattributes` pins `*.golden` to LF. |

Defects 1–6 were found by, or are covered by, tests written first.

## 3. Tests added

- `test/application/arcana_connection_lifecycle_test.dart` — 14 tests:
  disconnected → authorizing → connecting → connected; connecting → failed (dial
  failure and unreachable control plane); connecting → cancelled; lapsed
  subscription ends before any authorize request or dial; connected →
  disconnecting → disconnected; connected → reconnecting → connected (never
  `authorizing`/`failed`); reconnecting → not-connected when nothing can be dialed;
  authorization revoked → blocked; authorization expired → blocked; stale managed
  snapshot + dead engine is not Connected; disconnect, logout and dispose while
  authorization is pending cannot dial or publish; sign-out never publishes a
  signed-in state mid-teardown. Four of these failed before the change.
- `test/presentation/arcana_managed_flow_test.dart` — two widget tests:
  authorizing reads "Connecting…", cancel stays available, Locations is locked;
  connection details never claim Connected over a dead tunnel.
- Harness: authorization gate, injectable clock, service access in `test/support/managed_fakes.dart`.

## 4. Local commands and results (Windows 10)

**tamara-next**
- `dart format --output=none --set-exit-if-changed .` — pass.
- `flutter analyze --no-pub` — no issues.
- `flutter test --no-pub` — 419 pass, **3 fail**: `mobile_account`, `desktop_account`,
  `mobile_account_error` goldens. They reproduce with identical pixel counts on an
  untouched `origin/main` worktree, and the same job passes on Linux CI. Windows
  font rendering; no golden was regenerated.
- `flutter build windows --release` — built `tamara.exe`.

**vpn-web**
- `npm ci`, `npm run lint` (0 errors, 11 pre-existing warnings), `npx tsc --noEmit` — pass.
- `npm test` — first run 1218 pass / 1 fail (CRLF fixture, defect 8). Rerun after the
  fix: 1219 of 1219 pass.
- `npm run build` with non-production placeholders — pass (the production gate skips
  itself outside a production deploy by design; it was exercised separately below).
- `check-log-secrets`, `check-migration-versions` — pass.
- `ARCANA_PRODUCTION_DEPLOY=1 node scripts/check-production-config.mjs` — **fails closed**
  as intended (section 8).
- Local Supabase/SQL tests — not run: Docker Desktop is not running. CI job `sql-tests` covers them.

**singbox-vpn**
- `cargo fmt --check` — pass. `cargo audit` — pass (one allowed yanked-crate warning).
- `check-no-secret-logging.sh`, `check-no-legacy-identity.sh`,
  `check-workspace-version-consistency.sh` — pass.
- `cargo clippy --workspace --all-targets -D warnings` — **fails locally only**:
  unused imports in `external_authorization.rs` tests, which are `#[cfg(unix)]`.
- `cargo test --workspace` — all pass except one `admin` test needing the `openssl`
  binary (not installed here). Not claimed as a local pass.
- `offline-release-gate.sh --quick` — not run to completion locally: `python3` resolves
  to the Windows Store stub (exit 49).
- All three local-only gaps are covered by Linux CI, which passed on #134.

## 5. CI and security results

- tamara-next #42 (head `d8247a9`): Provenance/analyze/test, Qualification logic, PowerShell
  harness, Windows fail-closed daemon build — all pass. An earlier run correctly failed
  the clean-boundary gate on defect 7's wording; it was fixed, not bypassed.
- singbox-vpn #134: every CI job and the Security workflow (CodeQL Rust and Actions,
  audit, secret-logging, legacy-identity, OS matrix, offline gate, release build,
  real-sing-box validation) — pass.
- vpn-web: this PR's CI result is recorded in the PR.

## 6. Contract consistency

`docs/contracts/ARCANA_PRODUCT_V1.md` blob hash in all three working trees after the
changes above: identical. Route vocabulary is `fast` / `privacy_plus`;
`ONE_SERVER` / `TWO_SERVER` appear in no production code (one explanatory comment in a
vpn-web test). No fourth vocabulary was introduced. No new wire-contract fixture tests
were added: the existing suites (route directory, signing, authorize, links, fleet,
provisioning, claim) all pass and no mismatch surfaced.

## 7. Traces

### Managed renewal (verified, not redesigned)

client timer / `onResume` → `ManagedConnectionService._performRenewal` →
`POST /v1/vpn/authorize` (fresh `client_request_id`) → `lease_route_slots` extends the
live lease in place (same slots, same credentials, later `expires_at`, never shortened;
renewal does not consume capacity) and writes `extend_to` per slot → node
`POST /api/agent/leases/sync` returns `extend_to` → provisioning agent
`adopt_extensions` moves only `valid_until` (floored to the batch grid, capped, never
backwards, never for expired/revoked/superseded slots) → rendered sing-box config is
unchanged, so no restart and no secret rotation → local expiry stays enforced on the
node regardless.

Coverage by layer: client `test/application/managed_credential_renewal_test.dart`
(successful and repeated renewal, duplicate recover, backoff, restart, skewed clock,
unauthorized, entitlement, stale route, Privacy+ failover, expiry wins over a delayed
response); control plane `vpn-authorize.test.js` and
`supabase/tests/ephemeral_lease_pool_test.sql` (idempotent replay, renewal capped and
never shortened, revoked/too-late/rotated slot not renewed); node `lease_pool.rs`
(`renewal_extends_in_place_floored_capped_and_only_for_live_leased_slots`, sync
parsing). No end-to-end test crosses all three processes; that is a live check.

`vpn-admin user renew-native` extends a node-local `vpn-admin` user's native grant in the
local users file. Its own doc comment says nothing upstream calls it, and the Arcana
lease pool does not depend on it. It was left independent; no second renewal mechanism
exists.

### Connection state

DISCONNECTED → AUTHORIZING (entitlement, routes, authorize) → CONNECTING (engine dial,
re-entering AUTHORIZING for the next candidate) → CONNECTED. Recovery:
CONNECTED → RECONNECTING (engine `reconnecting`, phase `recovering`) → CONNECTED.
Teardown: → DISCONNECTING → DISCONNECTED. Fail-closed engine states
(`blocked`/`expired`/`revoked`) always win and map to BLOCKED. A stale connected phase over
an idle engine maps to DISCONNECTED.

## 8. Remaining blockers

**Live-test only**
- Real VPS / Windows / iPhone / Cloudflare / Supabase / Stripe behaviour, including the
  renewal chain across all three real processes and SQL tests against a real database.
- Network-change recovery: `ManagedConnectionService.recoverAfterNetworkChange` has no
  production caller (only tests), and no connectivity monitor exists in the client. How
  the app behaves on a real Wi-Fi/cellular switch depends on the native engine and must
  be observed live.
- Claim-token enforcement is intentionally disabled pending verified fleet rollout
  (the production gate reports it as a warning).
- The three Windows-only golden diffs and the Windows-only local gate gaps in section 4
  should be confirmed green on Linux CI for the final merged heads.

**Owner / legal input (the production gate fails closed on these, unchanged)**
- `src/app/terms/page.tsx`, `privacy/page.tsx`, `impressum/page.tsx` still contain
  `legal-todo` content: entity name, address, representative, VAT ID, retention
  periods, consent wording, dispute-resolution position. None was invented.
- Production values for `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL` and the
  Supabase, Stripe, signing-key, encryption-key, fleet, Resend and admin-origin
  bindings. The wiring expects these variable names; values were not available here
  and none were printed or committed.
- Merge approval for singbox-vpn #134 and this PR.

**Intentionally deferred**
- Android (no `android/` platform was created).
- Per-link / per-user traffic accounting: no trustworthy authenticated counter source
  in the shipped runtime; nothing was inferred or estimated.
- External `privacy_plus` Links stay fail-closed until a real external client is qualified.
- Pricing, Dependabot PRs #120–#122.

## 9. Not done in this pass

- `custom_connect_screen.dart` still reads the engine state directly. It drives
  user-defined, non-managed profiles that have no managed phase. Left as is on purpose.
- No fixture-level cross-repo wire-contract tests were added (section 6).

Verdict: the code changes are finished and merged where they affect runtime (tamara-next).
The freeze is not complete until singbox-vpn #134 and this PR are merged and `main` CI is
confirmed green in all three repositories; no implementation work is outstanding.

CODE FREEZE NOT READY — IMPLEMENTATION BLOCKERS REMAIN
