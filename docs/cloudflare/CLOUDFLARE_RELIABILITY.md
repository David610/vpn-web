# Reliability: safeguards, failure behaviour, deployment and recovery

Everything below is **implemented on branches and tested with mocks**; **nothing is deployed**. Items needing your approval are marked ⛔.

## 1. Safeguards implemented

| Safeguard | Where | Behaviour |
|---|---|---|
| Shared circuit breaker (`ControlPlaneGate`) | singbox-vpn `pacing.rs` | Any polling failure (network error, 429, 5xx, 401/403…) pauses **all** polling calls for `max(Retry-After, jittered exponential backoff 2 s → 60 s)`; one success reopens. Simulated hour of constant failure: ~1,200 attempts → ≤140. |
| `Retry-After` | `pacing.rs` | Seconds or HTTP-date, floor over own backoff, capped 1 h. |
| Typed errors | `worker_client.rs` | `ApiError::{Gated,Status}`; gated pauses log at debug, not warn. |
| Event channel | `GET /api/agent/events` + `events.rs` | Long poll (25 s), hub does **1 DB query per second for all waiting nodes** regardless of agent count; releases on job / authorization / entitlement / lease change; ~1 s reaction. 501/409/errors ⇒ agent polls at `poll_interval_secs` as before (never slower). |
| Reconcile timer | `events.rs::Schedule` | Even with a healthy channel every channel is re-synced every `reconcile_interval_secs` (60 s, min 15 s): a lost wake-up costs ≤60 s, not correctness. |
| ETag / 304 | `authorizations.js`, `worker_client.rs` | ETag covers non-secret state incl. effective revocation; unchanged ⇒ 304, **no decryption**. |
| Batched entitlement | migration `20261018000000` | 1 RPC instead of N; bounded (5) per-device fallback if the migration is absent. |
| Node-auth cache | `node-auth.js` (Node server only) | 5 s TTL, negative 1 s, bounded; revoked/quarantined nodes rejected ≤5 s later; off on Pages. |
| Write throttle | `node-touch.js` | `nodes.last_seen_at` ≤ 1 write / 30 s / node (was every poll). |
| Server hardening | `server/app.mjs`, `index.mjs` | Route allowlist `/api/agent`, in-flight cap → 503 + `Retry-After`, header/request timeouts, bearer-protected `/metrics` (by route template), logs without query strings, graceful shutdown, secrets least-privilege (agent-only host needs no `SUBSCRIPTION_TOKEN_HASH_KEY`). |
| Quota monitor | `scripts/cloudflare-quota-check.mjs` | 60/80/90 % + CPU-limit + forecast; exit codes 0–4; one GraphQL call per run. |

## 2. Failure behaviour by function

| Function | Control plane down / throttled | Data plane |
|---|---|---|
| Existing VPN connections | **Unaffected**: sing-box on the node keeps serving; no per-connection control-plane call. | up |
| New connections with a still-valid credential | Unaffected (credentials are enforced locally until `valid_until`). | up |
| Credential expiry / lease rotation | **Still enforced locally** every loop (≤`poll_interval_secs`); only the *report* to the control plane is deferred. Unchanged by this work. | up |
| Revocation (billing/abuse) | Delivered by event in ~1 s; if the channel is down, by polling at `poll_interval_secs`; if the control plane is down it cannot be delivered — the credential still dies at its local `valid_until` (lease lifetime ≤30 min). Urgent revocation therefore has a **bounded worst case = remaining lease lifetime** during a control-plane outage. | up |
| New provisioning / renewals | Wait (agent backs off, jobs stay `pending`, reaper re-queues expired claims). Resume automatically. | up |
| Subscription retrieval `/sub/*` | Stays on Pages; independent of the agent API. | n/a |
| Event hub / VPS API down | Agents see failures ⇒ gate ⇒ backoff ≤60 s; no storm. If Pages still serves `/api/agent/*` (rollback), agents fall back to polling there. | up |
| Supabase down | Hub/handlers return 503 + `Retry-After`; agents back off. | up |

Never traded for availability: no direct VPS exposure (443 only from Cloudflare ranges), no auth bypass, no secrets in logs (`check-log-secrets` unchanged).

## 3. Rollout plan (each ⛔ needs your go-ahead)

1. **Merge** the two branches via PR after review. ⛔ (not pushed/PR’d yet)
2. **Apply** migration `20261018000000_agent_control_plane_efficiency.sql` to Supabase `lzpvxmstspaaltvqzctl` (**production**; additive, 3 functions, no data change). ⛔ Back-out: `drop function` ×3 (the app falls back automatically). Not yet executed against any Postgres — **syntax-verified only by review; run it on a scratch database first** (no local Postgres/Docker exists on this machine).
3. **Choose the host** for the API. ⛔ Operator notes forbid extra VPS/services: pick an existing server (not a VPN exit that is expendable). Install Docker, copy `/etc/arcana/api.env` (0600): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VPN_SECRETS_ENCRYPTION_KEY`, `METRICS_TOKEN`, `PUBLIC_API_ORIGIN`, plus the fleet/agent variables that `/api/agent/{enroll,bootstrap-status,metrics}` read (check each handler; they fail closed when missing).
4. **Firewall**: allow 80/443 only from Cloudflare ranges (and your admin IP for SSH); deny all else.
5. **DNS**: create `api-agent.<zone>` as a **proxied** A/AAAA to the host (orange cloud; not a Worker route). ⛔ Use a zone you own; never reuse the blocked project’s names.
6. `docker compose -f deploy/api/docker-compose.yml --env-file /etc/arcana/api.env up -d --build`; verify `/healthz`, 401 without a key, `/metrics` with the token.
7. **Canary** on a disposable node (91.244.71.165 has no agent — install one): set `worker_url` to the new host, watch `/metrics`: expect ~380 req/h, claim → job latency < 2 s. ⛔ (node change)
8. **Real DE/RU nodes** one at a time; keep the old `worker_url` in the previous config as rollback. ⛔ (needs credentials I do not have)
9. Schedule `cloudflare-quota-check.mjs` every 15 min (systemd timer) and alert on exit ≥1.

## 4. Rollback
* Node: restore the previous `/etc/vpn/provisioning-agent.toml` and `systemctl restart vpn-provisioning-agent` (agent state files are unchanged by this work).
* API: `docker compose down`; point `worker_url` back. Pages project no longer exists, so a **rollback to Pages requires re-creating it** — ⛔ and that is exactly the project class that was blocked (8000119); do not do it without Cloudflare’s answer.
* DB: migration is additive; leaving it applied is harmless.

## 5. Recovery after quota reset / outage
The gate reopens by itself (≤60 s probe cadence). After a Workers quota lockout the daily counter resets 00:00 UTC; with the API off Workers there is no lockout to recover from.

## 6. Open risks
* Cloudflare’s abuse block 8000119 is unexplained and independent of this work.
* Real Supabase latency and real VPS capacity unmeasured.
* `/sub/*` and portal remain on Pages and have no deployment target now that the projects are deleted (**production website/subscription delivery is currently offline**).
* Event hub polls Supabase once per second while any agent waits: ≈86k extra small queries/day on the production DB; use Supabase Realtime/LISTEN if that is undesirable.
