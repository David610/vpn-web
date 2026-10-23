# Cloudflare quota incident report (Sept–Oct 2026)

Status: investigation complete to the limit of the surviving evidence; fixes implemented on branches, **not deployed**.
Evidence files: [`evidence/pages-functions-hourly-2026-09-16_to_2026-10-16.csv`](evidence/pages-functions-hourly-2026-09-16_to_2026-10-16.csv), [`evidence/audit-log-pages-events.csv`](evidence/audit-log-pages-events.csv).
All times UTC. No credentials appear in this document.

## 1. What was reported

Two Cloudflare emails: **"Workers daily request limit exceeded"** and **"Workers CPU limit exceeded"**. Pages Functions run on the Workers platform, so a Pages project with Functions consumes the Workers Free quotas: 100,000 requests/day and 10 ms CPU per invocation. (Documented Free-plan limits; the account is on Free: every zone and the account report the Free plan.)

## 2. Incidents

| Field | Incident A — daily requests | Incident B — CPU |
|---|---|---|
| Affected service | Pages Functions (Workers runtime), projects `arcana-web-epw` and `arcana-web-qual` | same |
| Limit | 100,000 requests/day (Workers Free) | 10 ms CPU/invocation (Workers Free); status `exceededResources` (error 1102) |
| Observed | 10-06: 108,584 · 10-07: 124,878 · 10-08: 123,920 · 10-09: 117,715 (see §4 on how these relate to the limit) | `exceededResources` on 09-27 (1,230), 09-28 (620), 09-29 (120), 09-30 (770), 10-01 (760), 10-07 (1,090), 10-08 (570); CPU p99 20–39 ms vs 10 ms limit |
| Time | Daily total first crossed 100k at 22Z on 10-06, 14Z on 10-07, 17Z on 10-08, 20Z on 10-09 | Continuous 09-27 → 10-08 |
| Trigger | Step from ~765 req/h to ~7,000 req/h at **10-06 ≈09:00Z** | Heavy handler on every poll |
| Root cause | Provisioning agents poll three endpoints on a fixed 3–5 s timer, forever, with no backoff or conditional fetch | `/api/agent/authorizations` decrypts every credential and runs one sequential `device_entitlement` RPC per principal on **every** poll; AES key re-imported per decrypt |
| Impact | Control plane unreachable/unreliable for nodes and website; notes record the control plane "unreachable since 2026-10-06" | Same requests failed with 1102 |
| Fix | VPS-hosted agent API + event channel + pacing (this change set) | Batching, ETag/304, key cache (this change set) |
| Confidence | **Confirmed** for the traffic pattern and the arithmetic; **probable** for which node/build produced the 10-06 step (see §5) | **Confirmed** (CPU quantiles + code) |

## 3. Timeline

| When | Event | Source |
|---|---|---|
| 09-21 15:12 | `arcana-web-epw` Pages project created | account audit log |
| 09-22 → 10-05 | ~765 req/h ≈ 18–19k/day, flat | analytics CSV |
| 09-26 / 10-02 | agent gains lease sync (4cc6917) and external-authorization reconcile (058f610) that run **every loop iteration** | `git log -S` in singbox-vpn |
| 09-27 | first `exceededResources` | analytics |
| 10-04 20:01 | `arcana-web-qual` created | audit log |
| 10-06 ≈09:00 | step to ≈7,000 req/h, flat 24 h, no day/night pattern | analytics |
| 10-07 18:00–23:59 | **zero invocations** for 6 h — consistent with the daily limit locking the project out | analytics |
| 10-08 ≈06:00 | step down to ≈4,900 req/h (one source stopped) | analytics |
| 10-08 | `arcana-web-qual` deploys blocked, code 8000119 (abuse block — **not** a quota; see §6) | operator notes |
| 10-10 06:50 | both Pages projects deleted | audit log |

## 4. Reconciling 7,000 req/h with 108–123k req/day

7,000 × 24 = 168,000, yet the observed daily totals are 108–125k. Resolved from the hourly data:

* 10-06 started at 09:00 (≈15 h × 7,000 ≈ 105k) — explains 108k.
* 10-07 had **six zero-invocation hours (18:00–23:59)** — 18 h × 6.9k ≈ 124k — explains 124.9k.
* From 10-08 06:00 the rate fell to ≈4,900/h; 10-08 also has a zero hour at 23:00.
* 10-09 ran all 24 h at ≈4,900/h = 117.7k with **no** lockout, although the 100k line was crossed at 20Z. So enforcement was not a clean cut at 100,000. **Unresolved:** exact enforcement/sampling semantics of Cloudflare's counter; analytics are adaptive-sampled. This does not change the conclusion: sustained consumption was above the Free limit.

## 5. Root cause, with evidence

1. **Fixed-interval polling of three endpoints.** `apps/provisioning-agent/src/main.rs` loop: every iteration runs `lease_pool.tick` (→ `POST /api/agent/leases/sync`), `external.tick` (→ `GET /api/agent/authorizations`) and `poll_once` (→ `POST /api/agent/claim`), then sleeps `poll_interval_secs` (default **3**). That is 3 requests per 3 s = **3,600 req/h = 86,400 req/day per agent** before heartbeat — one agent alone uses 86% of the Free quota.
2. **Baseline matches one older agent:** 5 s claim poll (720/h) + 60 s heartbeat (60/h) = 780/h; observed ≈765/h.
3. **The 10-06 step** (+≈6,200/h) fits additional agents running the build that includes the two per-iteration calls above (≈3,600–3,700/h each). Introduction dates (09-26, 10-02) precede it; release tags `v1.1.0-rc.*` (10-04) shipped it.
4. **No backoff on failure.** On error the loop slept the same interval. My notes record `ru1` rotating all lease slots every 20 minutes and restarting sing-box while the control plane was unreachable, i.e. the failure fed back into more load.
5. **CPU:** `functions/api/agent/authorizations.js` ran `await db.rpc("device_entitlement")` sequentially per principal and `decryptSecret` (which imported the AES key each time) per row, on every poll. Measured p99 CPU 20–39 ms (analytics) against a 10 ms limit.

### Not causes (checked)
* **Cloudflare DNS API.** The audit log shows heavy record create/delete on `sustechnologies.eu` and the Cyrillic zones (dozens of operations/day on 08-12…10-13). That is DNS API usage, which has its own limits (1,200 requests/5 min); no 429s are recorded. It is not part of the Workers quota. Not investigated further; see Remaining risks.
* **Humans/bots.** Flat 24-hour profile with no diurnal shape ⇒ machine traffic.
* **Other Functions on the account:** `pages-worker--7459708-production` (mkhitaryan.io / first-consulting) shows 10–480 req/day. Negligible.

## 6. Abuse block 8000119 — separate, unresolved

Deploys to `arcana-web-qual` were refused with code 8000119 on 2026-10-08 while `*.pages.dev` kept serving. This is a Cloudflare abuse/safety action, **not** a quota error, and reducing Workers usage must not be presented as a remedy. The project is deleted, so it cannot be inspected through the API now. Prior working hypothesis (unproven): the Functions bundle rendering VLESS/Hysteria2 configs. Only Cloudflare can lift/explain it; appeal draft is in `docs/runbooks/CLOUDFLARE_BLOCK_RECOVERY.md` (on branch `audit/2026-10-07`). **Do not re-create the project under another name to evade it.** Hosting the agent API outside Pages also removes the config-rendering Functions from Cloudflare's scope for that traffic, but that is a side effect, not a fix.

## 7. Evidence gaps (not invented)
* No per-path or per-client breakdown: the projects were deleted before this investigation and GraphQL has no path dimension for Pages Functions.
* Node-side configs/journals could not be read: `ru1`, `de1`, node-1 — no approved credentials; `157.173.27.46` — SSH host key changed (`SHA256:cPyBUNHh…`), not overridden; `91.244.71.165` — reachable, runs v1.3.1, **no provisioning agent** (so not a polling source).
* Zone-level analytics, WAF/rate-limit rules, R2 and Zero Trust: token lacks read scope.
* Cloudflare’s billing/notification history for the two emails was not available (no notification scope).

## 8. Fixes (see CLOUDFLARE_VERIFICATION_REPORT.md for test evidence)
| Cause | Fix | Repo/branch |
|---|---|---|
| 3 polls per iteration on Pages | Agent API on a VPS hostname outside Pages/Workers; events + reconcile instead of fixed polling | vpn-web `fix/cf-quota-control-plane`, singbox-vpn `fix/cf-quota-agent` |
| No backoff / storm | `ControlPlaneGate` circuit breaker, jittered exponential backoff, `Retry-After` | singbox-vpn |
| Unconditional full fetch | ETag / `If-None-Match` → 304 before any decryption | both |
| N+1 entitlement RPC | `device_entitlements_batch` (migration `20261018000000`, **not applied**) with bounded fallback | vpn-web |
| Redundant writes | `nodes.last_seen_at` PATCH on every claim throttled to 30 s | vpn-web |
| CPU | AES key import cached | vpn-web |
