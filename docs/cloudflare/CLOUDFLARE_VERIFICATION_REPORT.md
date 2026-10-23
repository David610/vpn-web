# Final verification report

Date 2026-10-16. Branches (unpushed, no PR): vpn-web `fix/cf-quota-control-plane` (2 commits + this doc commit, base `ffd7f1d`), singbox-vpn `fix/cf-quota-agent` (2 commits, base `de8f7d5`). Archived `tamara` was not touched; `tamara-next` needs no change (it is a client, not an agent).

## Root causes found
See CLOUDFLARE_INCIDENT_REPORT.md: (1) three endpoints polled every 3–5 s per agent, (2) no failure backoff, (3) N+1 + per-poll decryption (CPU), (4) redundant per-poll writes. Abuse block 8000119 is separate and unresolved.

## Tests executed (all run locally; results are real output)
| Suite | Command | Result |
|---|---|---|
| vpn-web functions + server + scripts | `npx vitest run functions server scripts` | **128 files, 1,357 tests passed** (baseline before changes: 141 tests in the agent-endpoint subset, all green) |
| vpn-web lint | `eslint functions server scripts/loadtest` | 0 errors (9 pre-existing warnings) |
| singbox-vpn provisioning-agent (WSL Ubuntu, cargo 1.94.1) | `cargo test -p provisioning-agent` | **160 passed** (baseline 126) |
| singbox-vpn | `cargo clippy -p provisioning-agent --all-targets -D warnings`, `cargo fmt` | clean |
| Quota monitor | vitest + one live call | 11 tests pass; live run: `ok: 98 req today` |

Scenarios covered by automated tests: retry storm bound (simulated outage ⇒ ≤140 attempts/h), HTTP 429 + `Retry-After` closing the gate for all endpoints, 5xx on events, connection errors, success reopening, job reports never blocked, 304 handling, ETag changes on entitlement flip / credential re-issue / schema, batch RPC fallback while migration absent, event hub (O(1) DB calls for 200 waiters, supersede, abort, DB error backoff, timeout), node-auth cache TTL/revocation/eviction, claim write throttle, in-flight shedding, route allowlist, metrics label hygiene (no ids/tokens), 25/100/300-concurrency load, threshold behaviour 60/80/90 %.

**Not covered (explicit):** real Supabase/Postgres (migration never executed; no Postgres/Docker here); real Cloudflare quota exhaustion (deliberately not attempted); Cloudflare-to-VPS connectivity faults; deployment rollback drill; agent ↔ Node server end-to-end across the real network (contract verified by matching JSON shapes and unit tests on both sides only); VPN connection-time and failover targets (**not measured; the data plane is unchanged by this work, so no regression is claimed and no improvement is claimed**).

## Before / after (measured vs derived)
| Quantity | Before | After | Basis |
|---|---|---|---|
| Control-plane calls per agent per hour, steady state, 3 s poll | ~3,660 | ~384 (events 144 + reconcile 180 + heartbeat 60) | derived from code; **not measured on a node** |
| Share of Workers Free daily quota per agent | 88 % | 0 % (API off Workers) | derived |
| Calls per agent during a 1 h control-plane outage | up to ~3,600 | ≤ ~140 | unit-test simulation |
| `nodes` PATCH writes in the 15-s×3 mock load run | 10,993 | 6 | measured, same harness (request totals differ: 10,993 vs 13,078 claims) |
| Node-auth DB lookups, same run | one per request | ~914 / 31k requests | measured with the cache on (no "before" run; before = one per request by code) |
| DB calls per `/authorizations` with 12 principals | 14 (2 + 12 sequential) | 3 | by construction + test (`device_entitlements_batch`) |
| AES key imports per N decrypts | N | 1 | test |
| Authorization p95, 100 concurrent, 20 ms simulated DB latency | not measured | full 253 ms, conditional 203 ms (laptop, shared with load generator) | measured |
| Claim p95 at 25/100/300 concurrent | not measured | 59 / 136 / 347–553 ms | measured |
| `/authorizations` p95 at 300 concurrent | not measured | ~1.2 s | measured; **target <500 ms NOT met in this rig**; profile shows API process 36 % idle, so the rig (3 processes on one laptop, closed loop) is the bottleneck — unproven on a real VPS |

## Production verification
**None performed.** Nothing is deployed; production Pages projects no longer exist; node access was unavailable. No production state was changed by me in Cloudflare, Supabase, or any VPS (only read-only API calls and read-only SSH to `91.244.71.165`).

## Remaining risks
1. Website, portal, `/sub/*`, Stripe webhooks have **no live host** (projects deleted 2026-10-10). Needs a decision (see below).
2. Abuse block 8000119 unexplained; re-creating Pages Functions that render VPN configs may be blocked again.
3. Migration unexecuted; event hub load on production DB; Supabase latency unknown.
4. Node-side facts unverified: which agent version/poll interval each node runs, `ru1`’s lease-rotation loop.
5. Subscription refresh interval of clients is unmeasured (the next quota risk if `/sub/*` stays on Workers: >60k/day at 1,000 users with hourly refresh).
6. Performance targets (1-hop <3 s, 2-hop <5 s, failover <5 s, API p95 <500 ms, 25–200 tunnels) are **unverified**; only the API portion was exercised, in a mock rig.
7. DNS API churn on the fleet zones is uninvestigated.

## Sustainable capacity (modelled; see QUOTA_BUDGET)
Agent plane: unlimited by Cloudflare quotas on the VPS; ~384 req/h/node. Pages-hosted user plane: safe to ~1,000 users only if client refresh ≥12 h; unsafe at hourly refresh.

## Costs
$0 Cloudflare. No paid plan enabled. Paid fallback (not recommended): Workers Paid $5/month.

## Changes requiring your approval
Push/PR of both branches; applying the migration to production Supabase; choosing and provisioning the API host; creating the proxied DNS record; changing `worker_url` on any node (canary first); re-creating/redeploying anything on Cloudflare Pages; reading `ru1`/`de1`/node-1 and accepting the new `157.173.27.46` host key; rotating the pasted Cloudflare token and the other pasted secrets.
