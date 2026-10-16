# Cloudflare quota budget and capacity model

Plan: **Free**. Documented limits used: Workers/Pages Functions **100,000 requests/day** and **10 ms CPU per request**; Cloudflare DNS API **1,200 requests per 5 minutes**. No paid product is enabled or recommended without explicit approval.

## 1. Request budget per agent (derived from code, not measured on a node)

| State | Calls per agent per hour | Per day | % of 100k/day |
|---|---|---|---|
| **Before** (poll 3 s: claim + authorizations + lease sync, + heartbeat 60 s) | 3,600 + 60 = **3,660** | 87,840 | **88%** |
| Before, poll 5 s | 2,160 + 60 = 2,220 | 53,280 | 53% |
| After, event channel healthy, on the VPS | events 144 (25 s) + reconcile 3×60 + heartbeat 60 = **~384** | ~9,200 | **0% of Workers** (not on Workers) |
| After, **fallback polling** (no event channel) | same shape as before but authorizations are 304s | ~87,840 | would still be 88% **if left on Pages** |
| After, control plane failing | gate: capped ≈ one probe per ≤60 s ⇒ ≤ ~140 attempts/h simulated | — | — |

Conclusion: on the Free plan **one agent polling at the default 3 s fills 88% of the daily Workers quota; two exceed it.** No code change to the polling can make a 3-node fleet fit inside Workers Free while keeping ~1 s reaction time; the agent API therefore moves off Workers.

## 2. Why proxied traffic is the right place
HTTP requests to an origin through a *proxied* DNS record are not Workers invocations and are not metered against the Workers quota on Free. The API hostname must be an orange-cloud A/AAAA record to the VPS, **not** a Worker route and **not** a Pages custom domain. (To be created at cutover; needs your approval.)

## 3. Capacity model (assumptions flagged)

Agent traffic scales with **nodes**, not users. User-facing traffic (subscription fetches, portal) scales with users and stays on Pages unless measured otherwise.

Assumptions (unverified): 3 nodes (DE, RU, one more); each device refreshes its subscription every 12 h (client-controlled; Hiddify default is 1 h in some builds — **measure**); 3 devices/user; portal/page-driven calls ≈ 20/user/day.

| Active users | Agent calls/day (3 nodes, new design, on VPS) | Subscription fetches/day on Pages (3 devices × 2/day) | Portal/API/day (20/user) | Pages Workers total/day | % of 100k |
|---|---|---|---|---|---|
| 1 | 27.6k (VPS) | 6 | 20 | ~26 | 0.03% |
| 10 | 27.6k (VPS) | 60 | 200 | ~260 | 0.3% |
| 100 | 27.6k (VPS) | 600 | 2,000 | ~2.6k | 2.6% |
| 1,000 | 27.6k (VPS) | 6,000 | 20,000 | ~26k | 26% |

At 3 devices refreshing hourly instead: 1,000 users ⇒ 72,000 subscription calls/day ⇒ ~92k total ⇒ **92% — unsafe**. The subscription endpoint, not the agents, would then be the next quota risk; its refresh interval (`profile-update-interval`) is the lever. **Worst case** (all clients 1 h, 1,000 users) exceeds a safe margin; the migration of `/sub/*` to the VPS API is the documented next step if measured usage passes 60% (see thresholds).

VPS side: laptop load test (not a production VPS, load generator on the same host) sustained ≈480 authorization rps and ≈1,000 claim rps with 20 ms simulated DB latency, p95 ≤ 267 ms at 100 concurrent and 136 ms for claim; closed-loop 300 concurrency saturated the test rig (p95 ~1.2 s) with the API process 36% idle — treat the 300-concurrency number as a rig limit, not a service limit. Real Supabase latency has **not** been measured. A single Node process handles the modelled steady state (≈0.3 req/s average) with orders of magnitude of headroom.

## 4. Monitoring thresholds (60 / 80 / 90 %)

| Metric | Source | 60% | 80% | 90% | Response |
|---|---|---|---|---|---|
| Workers req/day (Pages) | GraphQL `pagesFunctionsInvocationsAdaptiveGroups` | 60k | 80k | 90k | 60: review top routes; 80: shed non-essential (admin dashboards auto-refresh 30 s → pause); 90: move `/sub/*` to VPS API |
| Workers CPU | same, `quantiles.cpuTimeP99` / `exceededResources` count | p99 6 ms | p99 8 ms | any `exceededResources` | profile route; move to VPS |
| DNS API ops | audit log count per 5 min | 720 | 960 | 1,080 | batch fleet DNS sync |
| Agent control-plane failures | VPS `/metrics` `requests{5xx,429}` | >1%/5 min | >5% | >20% | check Supabase/VPS; agents already back off |
| Event-hub waiters | `/metrics` (planned) | — | — | 0 waiters while nodes up | agents fell back to polling |

`scripts/cloudflare-quota-check.mjs` (planned, below) reads only the GraphQL endpoint once per run, so monitoring itself costs 1 API call, not Workers requests. **Billing alerts are notifications, not spending caps.** **Status: monitoring script and alert delivery are NOT yet implemented** — see Verification report "Remaining".

## 5. Costs
Current: $0 Cloudflare (Free). VPS: no new server is assumed; hosting the API on an existing disposable-to-production decision is yours (operator notes forbid extra VPS/services). Paid alternative if ever required: Workers Paid ($5/month base, 10M requests included) — **not** recommended now and **not** enabled.
