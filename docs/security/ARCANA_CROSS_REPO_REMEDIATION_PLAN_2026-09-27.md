# Arcana cross-repo remediation plan — 2026-09-27

Status: **ACTIVE — contracts in §3 are FROZEN for implementation.** Changing a frozen
contract requires an edit to this file (owner: CONTRACT) before code changes.

Scope: `David610/vpn-web` (control plane), `David610/singbox-vpn` (node / data plane),
`David610/tamara-next` (Arcana client). This is a remediation program, not an audit.
It turns three audit reports into one set of work items, frozen contracts, branch
ownership and acceptance gates.

## 0. Baseline

| Repo | `main` today | Audited commit | Audit report (branch, not merged) |
|---|---|---|---|
| vpn-web | `6b3828e` | `6b3828e` | `claude/arcana-vpn-security-audit-jntg6r`: `docs/reviews/ARCANA_WEB_CONTROL_PLANE_PRODUCTION_READINESS_AUDIT_2026-09-27.md` |
| singbox-vpn | `5cee2fa` (`v1.1.0`) | `5cee2fa` | `claude/singbox-vpn-audit-v6nqyz`: `docs/reviews/SINGBOX_VPN_PRODUCTION_READINESS_AUDIT_2026-09-27.md` (+ `evidence/2026-09-27/`) |
| tamara-next | `a57060b` | `a57060b` | `claude/arcana-vpn-audit-fzx0mv`: `docs/reviews/ARCANA_CLIENT_PRODUCTION_READINESS_AUDIT_2026-09-27.md` (+ `test/audit/production_readiness_audit_test.dart`) |

The reports are **not stale**: each audit is exactly one docs commit on top of the current `main`.
No unmerged branch contains remediation work. I checked the load-bearing claims again on `main`:

- exit role returns with no route rules (`singbox-vpn crates/compat-config/src/server.rs:70-79`);
- `default_lease_pool_size() = 32` (`apps/provisioning-agent/src/config.rs`);
- `report_complete_until_ack` / `report_fail_until_ack` loop forever (`apps/provisioning-agent/src/main.rs:185-225`);
- no `kill_on_drop` anywhere in the agent; `checksums.txt` is preferred over the pin (`deploy/almalinux/install.sh:1754`);
- `authenticateNode` checks only `revoked_at`, and nothing sets it (`vpn-web functions/lib/node-auth.js`);
- `assignDeviceProfile` reconciles with **account** entitlement (`functions/lib/device-assignment.js`);
- `handleSubscriptionUpdated` writes status with no ordering guard (`functions/lib/stripe-events.js:430`);
- `deleteRecord` has no caller;
- the client calls `authorize` from one place only, with no renewal; `SessionManager.restore()` maps offline to signed-out; `TamaraShell` awaits `initialize()` with no error handling.

New findings from this pass (not in any report):

- **NEW-01** — The relay's loopback self-test exception (`server.rs:82-89`, `"inbound": [vless-reality-in], ip_cidr 127.0.0.1/32, port <subscription>`) has no `auth_user` filter. **Every** customer on a relay can reach the relay's loopback subscription backend. This is SVPN-F01/F06 on relays.
- **NEW-02** — Managed exit-hop lease slots are ordinary exit users. A credential leased for the exit hop of a 2-server route is accepted from **any** source address, so the client, or anyone holding the credential, can use it `client → exit` directly. Invariant 2 is enforced only by client code today.
- **NEW-03** — sing-box 1.14.1 (`protocol/vless/inbound.go`, `protocol/hysteria2/inbound.go`) calls `UpdateUsers` only at construction. There is no runtime user API. `sing-vmess` `vless.Service.UpdateUsers` swaps the user map without synchronization. Invariant 5 therefore cannot be fully met on stock sing-box; see ADR-0004 (§4).

Local test capability (checked): WSL2 Ubuntu 24.04 (kernel 6.18) has network namespaces **and IPv6**. The audits had no IPv6, so dual-stack isolation and leak tests are possible here. Node, Rust, Go, Flutter/Dart and the Supabase CLI are present. Docker Desktop is stopped. No cloud-provider CLI or token is present. `singbox-vpn`'s `vps-acceptance.yml` needs an existing disposable host, so **the VPS tier is blocked until David provides disposable hosts or a scoped disposable Hetzner project** (§8).

---

## 1. Invariants → tracks, contracts, gates

| # | Invariant | Enforced by (work items) | Contract | Non-mock proof required |
|---|---|---|---|---|
| 1 | No usable VPN credential without capacity on the device's **own** subscription | C-01, C-02, C-04, C-06, A-06 | C-01, C-04, C-14 | integration (real schema) |
| 2 | 2-server = client→entry→exit→dest or fail | A-08, B-04, B-06, F-02 (no downgrade), E-02 | C-06, C-07, C-13 | protocol (pcap on each hop) |
| 3 | Tunnel traffic reaches the public Internet only | E-01…E-04 | C-16 | protocol + VPS (real metadata endpoint) |
| 4 | Renew before expiry without disconnecting | A-01, A-03, D-04 | C-03, C-15 | protocol soak (PID + stream continuity) |
| 5 | No node-wide restarts for routine customer events | A-03, A-04, A-05 | ADR-0004, C-11, C-15 | protocol/VPS soak (restart count) |
| 6 | Fail closed, never permanent lockout | F-01, F-02, F-03, B-06 | C-17, C-13 | device (Windows hardware) |
| 7 | Retired/quarantined node has no auth, jobs, DNS or assignments | D-01, D-02, D-03, B-03 | C-09, C-10 | integration + prod-RO (`dig`) |
| 8 | Stripe events idempotent and order-safe; old never resurrects terminal | C-02 | C-14 | integration (event-permutation replay) |

---

## 2. Unified blocker matrix

Report IDs: `F-nn` = vpn-web report; `SVPN-Fnn` = singbox-vpn report; `F-XXX-nn` / `Dn` = tamara-next report.
Several report IDs that describe one system failure are merged into one row.

- **Blocker** = must be fixed before the first paying customer. `YES (2S)` means a blocker for selling 2-server mode. `YES (plat)` means a blocker only if that platform ships.
- **Detectability** = how we would notice it in production today.
- **Roles** are defined in §6.

### Track A — Credential lifecycle (issue → renew → rotate → expire)

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A-01 | Client authorizes once and never renews. Credential dies 10–30 min after connect while the UI says Connected; no `client_request_id` is sent | F-CP-01, D1, D2 | tamara-next | vpn-web renewal (live); C-03 `renew_after` (additive) | YES | P0 | every managed user, every session; Windows then blocks all traffic | silent | CLIENT | RELQA | Protocol lab (real sing-box node + local vpn-web + headless engine): one session held ≥ 3 h, ≥ 6 renewals, credential bytes unchanged, sing-box PID unchanged, continuous stream never drops. Unit tests with **expiring** fakes cover renew-fail → retry → expiry → visible state, and changed-credential → make-before-break |
| A-02 | Every authorize error becomes "Could not reach Arcana"; one full node aborts the connect | F-CP-02, D3 | tamara-next | C-02 error table | YES | P1 | managed users of any full/not-ready node | customer-reported | CLIENT | RELQA | Per-code tests: `503 capacity_exhausted` / `route_not_ready` → next candidate, same mode; `409 not_entitled` → entitlement state, no retry; `429` → honours `Retry-After`, bounded; `409 idempotency_conflict` → one retry with a new id; never a mode change |
| A-03 | Idle lease-pool churn restarts sing-box about every 20 min on every node, whether or not anyone holds a lease | SVPN-F02 | singbox-vpn + vpn-web | C-15 (both repos); bootstrap writes explicit pool config | YES | P0 | all users on all fleet nodes, ~3×/h | low (journal only) | NODE-AGENT + CP-FLEET | RELQA | 24 h soak, pool 32, real agent + real sing-box against local vpn-web: 0 leases → 0 restarts outside the declared daily maintenance window; 10 renewing holders → 0 restarts; expiry/urgent revocation still refused ≤ 5 s after `expires_at` |
| A-04 | Every authorization change (create, enable/disable, rotate, expiry reconcile, lease rotation) restarts sing-box and cuts every user on the node | SVPN-F11, F-10 (node side) | singbox-vpn | ADR-0004; vpn-web job batching | YES (transitional part) | P1 | all users on the node per event | low | NODE-AGENT (+NODE-DP renderer), ADR by CONTRACT | RELQA | Transitional: ≤ 1 restart per apply window (default 30 min) plus urgent revocations, under synthetic churn of 60 creates/disables per hour, 24 h soak. Final: ADR-0004 spike shows add/remove user with other users' open REALITY and Hy2 connections intact |
| A-05 | Customers can trigger node restarts at will: `/api/vpn/rotate-credentials` (unused by the UI, no rate limit, random idempotency key) and assignment/device churn keyed by `Date.now()` | F-10 | vpn-web | A-04 | YES | P1 | all users on that customer's node, repeatable every few seconds | silent | CP-BILL | SECQA | `rotate-credentials` → 410. Account-level limits on assignment/device mutations (≤ 10/h). Deterministic idempotency keys. Test: 100 rapid assignment calls enqueue ≤ 1 node mutation per device per window |
| A-06 | Legacy (subscription-URL) credentials expire exactly at period end with no grace; expiry is pushed only on `invoice.paid`; a proration line can set a past expiry | F-19 | vpn-web | C-04 | YES | P1 | every legacy user, monthly and through dunning | customer-reported | CP-BILL | RELQA | Tests: `invoice.paid` delayed 6 h → node expiry stays ≥ period_end + 72 h; proration-first invoice never shortens expiry; `subscription.updated` pushes expiry; `unpaid`/`canceled`/`deleted` → DISABLE enqueued in the same handler |
| A-07 | Managed credentials orphaned in SecretStore after a crash; they survive logout and account deletion | F-SEC-03 | tamara-next | — | NO | P2 | local credential hygiene (bounded by lease TTL) | silent | CLIENT | SECQA | Startup and logout purge every `managed:*` ref (persisted non-secret index or prefix delete); audit test inverted |
| A-08 | No Direct/2-hop credential separation: exit-hop credentials are accepted from any source (managed: NEW-02; legacy: the via route reuses the Direct credential), so one Direct use links all Privacy+ sessions to the user's IP | SVPN-F10, NEW-02 | singbox-vpn + vpn-web | C-07 (slot classes, lease sync v2) | YES (2S) | P1 | privacy of every 2-server user | silent | NODE-DP (exit rules) + CP-FLEET (class-aware leasing) | SECQA | Protocol lab, real binaries, VLESS and Hy2: exit-hop credential of a 2S lease used directly from the client IP → refused; the same credential via a declared relay → works; legacy via-route credential ≠ direct credential |
| A-09 | Single encryption key (`VPN_SECRETS_ENCRYPTION_KEY`) and single route-signing key; no key id, rotation or escrow | F-34 (keys) | vpn-web | tamara-next key set (already supported) | YES | P1 | all stored credentials; all clients' route trust | n/a | CP-FLEET | SECQA | Ciphertext carries a key id; decrypt accepts 2 keys; server signs with a configured `key_id` and publishes an overlap set; rotation drill on staging; escrow runbook. Production rotation needs David's approval |

### Track B — Failover and health

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B-01 | Fleet health is liveness only: bootstrap enables neither protocol probes nor a Clash API, and READY does not require data-plane proof | SVPN-F07, web §10 | singbox-vpn + vpn-web | C-08 | YES | P1 | all users placed on a broken node | customer-reported | NODE-AGENT + CP-FLEET | RELQA | Bootstrap writes `[protocol_probe] self_probe = true`. A node with sing-box stopped, decoy unreachable, cert expired or 443 firewalled → DEGRADED within 3 probe cycles and absent from the next directory version; recovers after 5 passes. **Final proof on a real node (VPS tier)** |
| B-02 | Silence detection is lazy: it runs only on other nodes' heartbeats or an admin page view, so a single-node or all-down fleet is never marked FAILED | F-20a | vpn-web | — | YES | P1 | whole location | silent | CP-FLEET | RELQA | fleet-tick runs the silence sweep every minute. Real-schema test: 1 node, agent stopped → FAILED ≤ 4 min. A 10-minute control-plane outage does not trigger auto-replace |
| B-03 | No re-placement off FAILED/DRAINING nodes; drain waits passively, then force-retires under legacy users | F-20b/c | vpn-web | C-12, D-02 | YES | P1 | every legacy user on a failed/retired node | customer-reported | CP-FLEET | RELQA | FAILED/DRAINING → legacy devices re-placed make-before-break within 2 ticks (new identity `done` before the old is disabled). RETIRE is refused while assignments > 0 unless an explicit override is audited |
| B-04 | The 2-hop path (relay→exit→Internet) is never probed | SVPN-F07 | singbox-vpn + vpn-web | C-08 | YES (2S) | P1 | 2-server users of a broken pair | customer-reported | NODE-AGENT + CP-FLEET | RELQA | The relay probe runs client→relay→exit→probe URL with the probe user. A broken exit or allow-list → that pair's 2S routes withheld from the directory; never a 1-hop fallback |
| B-05 | REALITY stops accepting when the exit cannot reach or resolve the decoy; no signal | SVPN-F12 | singbox-vpn | B-01 | NO | P2 | REALITY users on the node | silent | NODE-DP | RELQA | Self REALITY handshake in the probe; decoy address pinned by a server DNS rule; lab: decoy down → DEGRADED |
| B-06 | No app-level reconnect: `recoverAfterNetworkChange` is dead code; `daemon_unavailable` is ignored and the UI stays Connected | F-DEAD-01, F-LNX-02 (UI) | tamara-next | C-13 | YES | P1 | every desktop user after tunnel loss | silent | CLIENT | RELQA | 3 consecutive status failures → "connection lost". Supervisor retries the same route, then the next same-mode candidate (≤ 6 dials, backoff). Windows block stays armed throughout. Fake-daemon tests + protocol-lab daemon kill |
| B-07 | `configured_users` counts lease slots and disabled users; auto-scale has no cap (cost runaway) | F-23 | singbox-vpn + vpn-web | — | NO (must be fixed before enabling auto-scale) | P2 | fleet cost, placement | low | NODE-AGENT + CP-FLEET | RELQA | Heartbeat reports `customer_users` and `lease_slots` separately (additive). Global and per-location auto-scale caps. 32 idle slots ≠ full |
| B-08 | Scheduler capacity race and sticky-node loss; heartbeat O(N²) | F-25, §16.2 | vpn-web | — | NO | P2 | placement skew | low | CP-FLEET | RELQA | DB-counted capacity under lock; sticky node kept; heartbeat does not scan all nodes |
| B-09 | Replacement robustness: a failed REPLACE blocks future replacements; no provider timeouts; FAILED servers/DNS kept forever | F-47, F-48, web §12 | vpn-web | D-02 | NO | P2 | cost, stuck fleet ops | silent | CP-FLEET | RELQA | Retry after a FAILED op; 20 s provider timeouts; abandoned-node cleanup after 24 h (DNS + server) |

### Track C — Billing and entitlement

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C-01 | Device capacity bypass: profile assignment, `/api/vpn/config` and Telegram assignment gate on **account** entitlement; `finalizeCreatedIdentity` ignores capacity; unbounded device rows per login | F-01, F-16, F-30 | vpn-web | C-01 contract; lease RPC wiring (CP-FLEET, wave 2) | YES | P0 | revenue: one subscription → unlimited working configs | silent | CP-BILL | SECQA | Audit repro committed and inverted (4th device → 403, no CREATE/ENABLE enqueued). One SQL function `device_entitlement(device_id)` is the only gate on every credential path. Property test: devices with usable credentials per subscription ≤ capacity. Device cap on `ensureSessionDevice`. Real-schema SQL test. Prod-RO query 8 before/after |
| C-02 | Out-of-order Stripe events resurrect `canceled` → `active` and overwrite pack counts; `invoice.paid` sets `active` | F-02 | vpn-web | C-14 | YES | **P0** (invariant 8; raised from P1) | revenue, capacity | silent | CP-BILL | RELQA | Handlers write only a Stripe-retrieved snapshot, guarded by a monotonic sync stamp; `canceled` is sticky. Test: every permutation of {created, updated(active), updated(past_due), deleted, invoice.paid, payment_failed} + duplicates → final row = Stripe's final state. Stripe CLI test-mode replay; no production |
| C-03 | Legacy "member" role not enforced in the shared account service (billing, others' devices); legacy cancel/resume endpoints | F-12, F-21 | vpn-web | — | YES (P3 if prod query 5 = 0) | P1 | owner's card, subscriptions, devices | silent | CP-BILL | SECQA | Owner required for billing and others' devices across web, `/v1` and Telegram; `/api/cancel-subscription` and `/api/resume-subscription` → 410; repro inverted |
| C-04 | Base price/product not validated: any subscription-mode checkout, or a portal plan switch, provisions VPN | F-31 | vpn-web | C-01 | YES | P1 (raised from P2) | revenue | silent | CP-BILL | SECQA | Unknown base price → subscription not counted by `device_entitlement` + alert; tests for checkout and `updated` |
| C-05 | Account deletion is not atomic: the user is banned first and can stay billed | F-08 | vpn-web | — | YES | P1 | billed locked-out users (consumer/GDPR) | customer-reported | CP-BILL | RELQA | Order: Stripe cancel (idempotency key) → revoke devices → ban. fleet-tick resumes unfinished deletions. Failure injected at each step converges; a banned user is never still billed |
| C-06 | Admin "disable" returns 500 for ≥ 2 identities and is undone by the next reconcile | F-07 | vpn-web | C-01 | YES | P1 | abuse response does not work | admin-visible 500 | CP-BILL | SECQA | Account `suspended_at` honoured by `device_entitlement`; suspend = urgent device + lease revocation + auth ban + audit; reconcile never re-enables; test with 3 identities |
| C-07 | No rate limits on `/v1/auth/*`, Telegram link, device creation, or the deletion password check | F-13, F-49 | vpn-web (+ Cloudflare WAF) | — | YES | P1 | credential stuffing, or lockout of all app logins | silent | CP-BILL; WAF rules by David | SECQA | App-level per-account/per-device limits in DB (tests); WAF per-IP rules configured (**production Cloudflare change — approval**) |
| C-08 | One account can drain a node's lease pool | F-11 | vpn-web | C-15 | NO | P2 | managed users on that node | 503 to others | CP-FLEET | RELQA | Live-lease cap per account per node ≤ max(2, 10 % of pool); audit Appendix B replay → others still lease |
| C-09 | One-click paid pack (§312j BGB) | F-35 | vpn-web | — | YES (legal) | P1 | accidental charges, legal | complaints | CP-BILL | SECQA | Confirm dialog with the new monthly total and a "Buy for €x/month" button |
| C-10 | Billing config/hygiene: `past_due` live forever, trial farming, duplicate Stripe customers, hard-coded prices, tax, `/v1` billing without recent auth | F-40, F-41, F-46, F-51, F-52, F-38 | vpn-web + David | — | NO | P2–P3 | revenue edge cases | low | CP-BILL; Stripe config by David | RELQA | Dunning ≤ 14 days confirmed (David); prices read from Stripe; customer created before checkout; recent-auth on `/v1` billing via a new-code path (C-02 compatible) |

### Track D — Node trust, retirement and jobs

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D-01 | Node API keys are never revoked: QUARANTINED/RETIRED nodes still authenticate, claim jobs (with user/device ids) and sync leases | F-05 | vpn-web | C-09; agent 401 handling (NODE-AGENT) | YES | P1 | fleet (compromised-node persistence) | silent | CP-FLEET | SECQA | Key revoked in the same transaction as → QUARANTINED/RETIRED; `authenticateNode` also rejects those states. Admin revoke/rotate action. **Enumerated-route test**: every `/api/agent/*` handler returns 401 for a quarantined key (new routes cannot skip it) |
| D-02 | DNS record is never deleted on retire; subdomain takeover of legacy `…:8443/sub/…` refreshes | F-06 | vpn-web | C-09 | YES | P1 | legacy users of retired nodes (interception) | silent | CP-FLEET | SECQA | RETIRE deletes DNS **before** destroying the server, then verifies by lookup; RETIRED requires `dns_removed_at`; abandoned-FAILED cleanup; one-off dangling-record report (deletions need approval). Prod-RO `dig` gate |
| D-03 | Claimed jobs are never re-queued; one agent crash stalls a device on that node forever (unique index) | F-09 | vpn-web | C-10 | YES | P1 | affected devices; deletion finalization | silent | CP-FLEET | RELQA | `claim_token` + `lease_expires_at`; fleet-tick reaper re-queues (attempt+1), fails after 5 with an alert; stale complete → 409 `stale_claim`; real-schema test |
| D-04 | The agent wedges forever on an undeliverable job report; heartbeat, jobs **and lease expiry** stop | SVPN-F03 | singbox-vpn | C-10 (works with today's 404 too) | YES | P1 | the node; leased credentials outlive `valid_until` | medium (node goes silent) | NODE-AGENT | RELQA | 4xx other than 401/408/429 is terminal; bounded retry with the unacked result persisted; heartbeat, lease tick and job loop are independent tasks. Tests: 404 on complete → heartbeats and rotations continue; expiry enforced through an outage that starts between claim and ack |
| D-05 | Timed-out `vpn-admin` children are not killed and apply later (after FAILED was reported); retries stack; `CREATE_USER` is not idempotent; stale mutations can reorder | SVPN-F04 | singbox-vpn | C-11 | YES | P1 | node/control-plane user divergence; untracked live credentials | silent | NODE-AGENT | SECQA | `kill_on_drop` + explicit kill/wait; `vpn-admin` lock wait bounded (exit 75 = busy); `CREATE_USER` keyed by the job idempotency key returns the existing user; per-user job-id floor rejects older mutations. Test: lock held by `update.sh` |
| D-06 | Revision rollout always fails (NULL `idempotency_key`); revision apply drops lease/probe users | F-17, SVPN-F14 | vpn-web + singbox-vpn | C-11 | NO (latent) | P2 | first real revision drops all leases | loud (500) | CP-FLEET + NODE-AGENT | RELQA | Deterministic key in one RPC; reserved users preserved; real-schema + node test |
| D-07 | Agent runs as root with a light sandbox; probe sing-box clients run as root against control-plane-chosen hosts; probe SOCKS unauthenticated | SVPN-F09 | singbox-vpn | — | NO | P2 | node root on a client bug | silent | NODE-AGENT | SECQA | Probe clients as a dedicated user; `ProtectSystem=strict` + explicit write paths; `RestrictAddressFamilies`; authenticated probe inbound |
| D-08 | Agent-reported data trusted: load, arbitrary URLs stored and shown to customers, peer probe creds | F-24 | vpn-web | — | NO | P2 | placement; customer redirection | silent | CP-FLEET | SECQA | URL host must equal node hostname; probe creds rotated + rate-limited; load reports bounded |
| D-09 | No remote update path for fleet nodes | SVPN-F16 | singbox-vpn + vpn-web | G-01 | NO (required before first fleet security patch) | P2 | slow patching | n/a | NODE-AGENT + CP-FLEET | RELQA | `UPDATE_NODE` job with canary, or a tested replace-instead-of-update runbook on the VPS tier |
| D-10 | Agent input loosely bounded (unknown config fields, body sizes, http `worker_url`, user-name charset) | SVPN-F17, F-22 (agent) | singbox-vpn | — | NO | P3 | robustness | low | NODE-AGENT | SECQA | `deny_unknown_fields`, body caps, https-only, name allowlist |

### Track E — Data-plane isolation

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E-01 | Exits let every tunnel user reach node loopback, cloud metadata, private ranges and the node's own public IPs (1-hop, 2-hop exit, lease users) | SVPN-F01 | singbox-vpn | C-16 | YES | P0 | every node; metadata = bootstrap env + enrollment; loopback = subscription backend, sshd, future admin APIs | silent | NODE-DP | SECQA | **Protocol tier, real sing-box 1.14.1, IPv4 + IPv6 (mocks not acceptable).** For every user class (customer, `lease-*`, legacy, hairpin, probe), on REALITY and Hy2, over 1-hop and 2-hop: every C-16 deny destination **and a DNS name resolving to each** → refused; public Internet works. Wave-2 host nft layer passes the same suite with the renderer rule removed. VPS tier: real Hetzner metadata endpoint refused |
| E-02 | Relay loopback self-test exception covers all REALITY users | NEW-01 | singbox-vpn | C-16 | YES | P1 | every relay | silent | NODE-DP | SECQA | Exception scoped to the probe user (`auth_user`); customer → relay `127.0.0.1:<sub port>` refused (protocol test) |
| E-03 | Subscription backend has one global rate bucket; any tunnel user (via E-01/E-02) or IPv6 /64 rotation denies delivery node-wide | SVPN-F06 | singbox-vpn | E-01 | NO | P2 | new imports/refreshes on the node | customer-reported | NODE-DP | SECQA | Backend on a Unix socket readable only by nginx; nginx `limit_req` keyed on /64 for v6 + a global zone; the audit flood script fails to starve a legitimate client |
| E-04 | No egress abuse policy (TCP/25 etc.) | SVPN-F15 | singbox-vpn | — | NO | P2 | fleet IP reputation, provider suspension | provider complaint | NODE-DP | SECQA | TCP/25 rejected for all users; abuse runbook |
| E-05 | Google egress hairpin changes users' egress and sniffs all flows; must never apply to customers or leases | SVPN-F26 | singbox-vpn | — | NO | P3 | privacy of users on hairpin nodes | silent | NODE-DP | SECQA | Hairpin restricted to its dedicated user (test); documented |

### Track F — Client fail-closed recovery

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F-01 | Windows reboot while connected locks a managed user offline: offline launch = signed out; Restore Internet exists only on Connect | F-REL-01, F-UX-01 | tamara-next | C-17 | YES | P0 | every Windows managed user who reboots connected | support tickets | CLIENT | RELQA (device: SECQA) | `signedInOffline` state; blocked-state card with Restore Internet in **every** account state/screen; Connect under block works (cached valid directory + usable lease) or is hidden; audit test inverted; Windows B15 WIN-REBOOT cases pass on hardware |
| F-02 | Launch hangs forever on any route-directory failure (skew > 30 s, one bad route, corrupt version file, `HttpException`) | F-REL-02, F-REL-03, F-REL-04, D4 | tamara-next | C-05 | YES | P0 | managed users with clock skew, or after any server-side directory mistake | support tickets | CLIENT | RELQA | All exceptions mapped to typed phases at the managed boundary; launch shows error + retry ≤ 15 s in every failure; C-05 skew rules; invalid routes skipped and counted; corrupt version file → `.bak` or reset floor + report; audit tests inverted |
| F-03 | Switching server/location releases the WFP block (leak ≤ 45 s) | F-PRIV-01 | tamara-next (daemon overlay) | C-13 | YES (plat: Windows) | P1 | every Windows switch | silent | CLIENT | SECQA | Daemon `replace-runtime` keeps WFP armed; service-trust switch case; device pcap: 0 non-tunnel packets during a switch |
| F-04 | Linux: fail-open on daemon crash, stale ip rules, packaging broken | F-LNX-01, F-LNX-02 | tamara-next | — | YES (plat: Linux) | P1 | Linux users | silent | CLIENT | RELQA | Explicit build tags; socket dir/path fixed; stale-rule cleanup on start; UI says "no kill switch" |
| F-05 | Apple: tunnel not restartable, no fail-closed; macOS keychain entitlement missing | F-APL-01, F-MAC-01 | tamara-next | — | YES (plat: Apple) | P1/P2 | Apple users | silent | CLIENT | RELQA | Device-verified on a Mac/iPhone |
| F-06 | Hosts without IPv6 or nftables cannot connect | F-REL-05 | tamara-next | — | NO | P2 | some Linux hosts | error | CLIENT | RELQA | Capability detection + clear message |

### Track G — Supply chain

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G-01 | sing-box download prefers a same-origin `checksums.txt` over the pinned SHA (install, update, CI) | SVPN-F05 | singbox-vpn | — | YES | P1 | root on every new/updated node | silent | SUPPLY | SECQA | The pinned hash is always required; upstream sums optional and must agree; shell test with a poisoned `checksums.txt` → refuse, in all three places |
| G-02 | Bootstrap runs `install.sh` fetched by mutable tag as root | F-37, SVPN-F27 | vpn-web + singbox-vpn | release publishes the `install.sh` hash | YES | P1 (raised) | root on every new node | silent | CP-FLEET + SUPPLY | SECQA | User-data pins commit SHA + SHA-256 of `install.sh`; mismatch aborts before execution; test |
| G-03 | Client Go toolchain 1.25.5: 49 advisories in the SYSTEM/root daemon binary; old grpc; no govulncheck | F-SUP-01 | tamara-next | — | YES | P1 | privileged daemon | silent | SUPPLY | SECQA | Current patched Go in every workflow; grpc bumped; `govulncheck` blocking in CI for reachable vulns |
| G-04 | `native/boxddctl` has no `go.sum`; the build runs `go mod tidy` | F-SUP-02 | tamara-next | — | YES | P1 (raised) | controller binary | silent | SUPPLY | SECQA | `go.sum` committed; `-mod=readonly` everywhere; CI fails on a tidy diff |
| G-05 | Release build restores a rust-cache | SVPN-F24 | singbox-vpn | — | NO | P2 | release integrity | silent | SUPPLY | SECQA | No cache in release jobs |
| G-06 | Production is not at `main`; no `/version`; no migration gate | F-29 | vpn-web | — | YES | P1 | whole control plane | silent | SUPPLY | SECQA | CI deploy with SHA; `/version`; Functions refuse service when the schema version is behind. **Production deploy = approval** |
| G-07 | Branch/tag protection unverified in all 3 repos | SVPN §Supply, F-37 | all | — | YES | P1 | every release | n/a | David (settings) | SECQA | `gh api` rulesets show tag + main protection, required reviews and checks |
| G-08 | Client: no production signing, installer or updater; downgrade allowed; release builds do not fail on missing defines | F-REL-06, F-REL-09 | tamara-next | — | YES | P1 (L) | cannot ship fixes | n/a | CLIENT + SUPPLY | SECQA | Signed installer + authenticated update channel + version floor; release build fails without required defines |
| G-09 | Uninstaller deletes unowned binaries and runs unverified code from `main` | SVPN-F13, SVPN-F23 | singbox-vpn | — | NO | P2 | operator hosts | loud | SUPPLY | SECQA | Leave-by-default; verified-release fallback; hermetic test |
| G-10 | `npm ci` needs `--legacy-peer-deps`; `next lint` skips `functions/` and `scripts/` | F-42 | vpn-web | — | NO | P3 | CI hygiene | n/a | SUPPLY | SECQA | `npm ci` clean; eslint covers `functions/` and `scripts/` |
| G-11 | If ADR-0004 adopts a patched sing-box: reproducible build + attestation of the patch, like the client's patched daemon | NEW-03 | singbox-vpn | ADR-0004 | conditional | P1 | every node | n/a | SUPPLY | SECQA | Pinned upstream commit + patch hash in the manifest; Sigstore provenance; installer verifies |

### Track H — Privacy

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H-01 | Plaintext subscription/provisioning URLs stored in `provisioning_jobs.result`; `provisioning_url` shown to every admin | F-04 | vpn-web (+ agent result) | — | YES | P1 | every legacy credential in the DB and backups | silent | CP-FLEET | SECQA | `complete.js` stores an allowlist of fields only; admin sanitizer redacts every URL-like field; purge migration prepared (**production run = approval**) |
| H-02 | No retention anywhere; `node_revisions` keeps full secrets forever; privacy policy is a draft and inaccurate | F-18, SVPN (revisions) | vpn-web + David | — | YES | P1 | GDPR, breach impact | n/a | CP-FLEET (jobs), David (text) | SECQA | Retention jobs (leases 30 d, `stripe_events` 90 d trimmed, samples → daily after 7 d, revisions keep last 2); policy matches §15 of the web report |
| H-03 | DNS sent to explicit resolvers leaves the exit in plaintext (`hijack-dns` without `sniff`) | F-PRIV-03 | tamara-next | — | YES | P1 | every user's DNS to third-party resolvers | silent | CLIENT | SECQA | `sniff` before hijack; protocol lab pcap: 8.8.8.8 query goes via DoH; Windows device check |
| H-04 | Legacy migration backup keeps plaintext Hysteria2 passwords forever | F-SEC-01 | tamara-next | — | YES | P1 | local credentials | silent | CLIENT | SECQA | No `configs/` copy (or encrypted + deleted after migration); included in logout, deletion and uninstall cleanup |
| H-05 | Exits resolve every customer domain through the provider's plaintext resolver | node §Network privacy | singbox-vpn | — | NO | P2 | per-exit browsing log at the provider | silent | NODE-DP | SECQA | Local caching resolver with DoT/DoH upstream; pcap: no plaintext :53 egress from the exit |
| H-06 | Alert emails with user ids go to a personal iCloud address | F-28 | vpn-web | — | NO | P2 | PII leak | n/a | CP-FLEET | SECQA | `ALERT_TO_EMAIL` env var; no user ids in email |
| H-07 | Node enumeration: `/v1/routes` served to any free account | F-26 | vpn-web | C-05 (compatible form) | NO | P2 | censorship resistance | n/a | CP-FLEET | SECQA | Non-entitled accounts get a signed empty directory (200, `routes: []`) — **not 403**, which the client treats as session invalid |
| H-08 | IPv6 and DNS leak behaviour unverified on every platform | client §6, node §IPv6 | tamara-next + singbox-vpn | — | YES | P1 (evidence gap) | all users | n/a | — | SECQA | Dual-stack protocol lab (WSL) + Windows device: no v6 or DNS leak with IPv6 on and off |

### Track J — Platform and operations readiness

| ID | Finding | Sources | Repo owner | Cross-repo deps | Blocker | Sev | Blast radius | Detectability | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| J-01 | Live site serves draft Terms/Privacy and a placeholder Impressum; the legal gate is opt-in | F-03 | vpn-web + David/legal | — | YES | P0 (launch) | legal | visible | SUPPLY (gate) + David (text) | SECQA | Gate runs on the production branch and fails on draft markers/placeholders; final text from David |
| J-02 | No alerting; many silent failures | F-36 | vpn-web (+ node counters) | — | YES | P1 | everything | — | CP-FLEET | RELQA | Alerts: fleet-tick stale, webhook failures, stuck claims, pending age, deletion backlog, empty directory, lease exhaustion, restart counts |
| J-03 | Backup/restore never drilled | F-34 | vpn-web | — | YES | P1 | data loss | — | RELQA + David | RELQA | Restore drill into a scratch project; documented RTO/RPO |
| J-04 | SQL tests are stale and not in CI; `fake-supabase` hides constraint bugs | F-32 | vpn-web | prerequisite for C/D tests | YES (raised; prerequisite) | P1 | test validity | — | CP-BILL | SECQA | `supabase/tests/*.sql` fixed and run in CI on replayed migrations (Postgres 16 + Supabase roles) |
| J-05 | Web session hardening: open redirect, localStorage + no `script-src`, other sessions kept after password change, service-role fallback in `gotrue.js`, missing REVOKEs, mutable admin audit | F-14, F-15, F-22, F-27, F-33, F-39 | vpn-web | — | NO | P2 | account takeover chains | — | CP-BILL | SECQA | Per-item tests; strict CSP; admin on a separate origin (later) |
| J-06 | Threat models and scope docs do not describe the fleet; contract docs drift | SVPN-F08, D9–D11 | all | — | NO (but threat model is part of E sign-off) | P2 | reasoning errors | — | CONTRACT | SECQA | Fleet section in `THREAT_MODEL.md`; contract docs match §3 |
| J-07 | Dead/legacy code and endpoints | F-21, F-DEAD-01 | all | — | NO | P3 | attack surface | — | owners | — | Removed after a production-log check |

### Track K — Performance (priority 4)

| ID | Finding | Sources | Repo owner | Blocker | Sev | Impl | Test | Acceptance criterion |
|---|---|---|---|---|---|---|---|---|
| K-01 | Client spawns a controller every 2 s; network observer runs even with auto-connect off | F-PERF-01 | tamara-next | NO | P2 | CLIENT | RELQA | Long-lived controller session or event stream; observer only when auto-connect is on; Windows CPU/battery measured |
| K-02 | N+1 reconcile per login; per-request GoTrue round trip (HS256); uncached `/v1/routes`; PostgREST 1000-row truncation | F-30, F-43, F-50, §16.2 | vpn-web | NO | P2 | CP-FLEET/CP-BILL | RELQA | Load script at 1k devices: p95 authorize < 300 ms; no truncation |
| K-03 | Node: `users.json` read per request; Hy2 CPU-bound; conntrack/fd untuned | SVPN-F19/F20/F21 | singbox-vpn | NO | P3 | NODE-DP | RELQA | Benchmark on the real VPS plan at 1/10/50 users |
| K-04 | Public pages load the Supabase SDK | F-44 | vpn-web | NO | P3 | CP-BILL | RELQA | ≤ 100 kB gzip JS on public pages |

**Blocker totals:** P0 = A-01, A-03, C-01, C-02, E-01, F-01, F-02, J-01. P1 blockers = A-02, A-04, A-05, A-06, A-09, B-01, B-02, B-03, B-06, C-03, C-04, C-05, C-06, C-07, C-09, D-01…D-05, E-02, F-03 (Windows), G-01…G-04, G-06, G-07, G-08, H-01…H-04, H-08, J-02…J-04. 2S-only: A-08, B-04.

---

## 3. Frozen contracts

Change classes:

- **additive** — old peers keep working; new fields are optional.
- **flagged** — new behaviour is behind a control-plane flag that is flipped only after the whole fleet or client base upgrades.
- **internal** — no cross-repo surface.

**Deployment order for every cross-repo change: vpn-web (accepts old and new) → singbox-vpn agents → tamara-next clients → flip the flag.**
Nothing here is backward-incompatible without a flag.

### C-01 Device entitlement (invariant 1) — internal

Device `D` is entitled at `t` iff:

- `D.status = ACTIVE`;
- `D`'s account is neither `suspended_at` nor `deletion_requested_at`;
- `D.subscription_id = S` is non-null and `S.account_id = D.account_id`;
- `S` is live at `t`: `active`, `trialing`, or `past_due` (until Stripe moves it to `unpaid`/`canceled`), **and** `S`'s base item price is `STRIPE_PRICE_ID`;
- `D`'s rank among `S`'s ACTIVE devices, ordered by `(subscription_assigned_at, id)`, is `< 3 × (1 + packs(S))`.

Admin grants count as a subscription with their own capacity. `public.device_entitlement(device_id) → (entitled, subscription_id, reason)` is the **only** gate for:

- lease/renew inside `lease_route_slots`, evaluated under the per-device lock;
- `CREATE_USER` / `ENABLE_USER` enqueue;
- `finalizeCreatedIdentity`;
- `/api/vpn/config`;
- Telegram routes;
- reconcile.

Account-level entitlement is for display only.

When entitlement is lost:

- managed: no new lease or renewal; a live lease ends ≤ `expires_at`;
- legacy: `DISABLE_USER` is enqueued in the same transaction as the state change.

`/v1/entitlement` is unchanged.

### C-02 Managed authorization — additive

ADR-0003 behaviour is kept. Additions:

- The 200 response may carry `renew_after` (RFC 3339).
- The error table is normative and must be copied into tamara-next's contract (today it lists only `route_stale`):

  | Status | Code | Meaning |
  |---|---|---|
  | 409 | `route_stale` | Route changed; refresh the directory |
  | 409 | `not_entitled` | Device has no entitlement |
  | 409 | `idempotency_conflict` | `client_request_id` reused for another route/device |
  | 503 | `capacity_exhausted` | Hop pool empty |
  | 503 | `route_not_ready` | Node has not reported its obfs secret |
  | 429 | `rate_limited` | Includes `Retry-After` |
  | 400 | — | Malformed request |

- Entitlement is evaluated inside the RPC (C-01).
- Leasing on a node not in {READY, CANARY} is refused with `route_stale`.

### C-03 Credential renewal (invariant 4) — additive

**Client timing and retries**

- Renew at `renew_after`, else at `expires_at − 5 min`.
- Clamp the renewal time to `[now + 30 s, expires_at − 60 s]`.
- Use a fresh `client_request_id` per logical renewal; reuse it for network retries of that same call.

**Outcomes**

| Outcome | Client behaviour |
|---|---|
| 200, same credentials | Update the expiry only; **no reconnect**. |
| 200, different credentials | Make-before-break reconnect under the kill switch (F-03). |
| 5xx, timeout or 429 | Jittered backoff, honouring `Retry-After`, until `expires_at − 30 s`. Then show `renewal_failed`. When the node cuts the tunnel, handle it as tunnel loss (C-13). |
| `not_entitled`, 401 or 403 | Stop renewing. Show the account/entitlement state. The block stays armed and Restore Internet is visible. |
| `route_stale` | Refresh the directory. If the route id still exists, authorize it again; otherwise use the next same-mode candidate (make-before-break). |

**Server guarantees (already true — must not regress):**

- a renewal extends every hop atomically;
- a renewal takes no new slot and does not count toward the rate limit;
- a renewal causes no sing-box restart;
- the node never enforces a later end than the `expires_at` it was told.

### C-04 Grace and expiry — internal

- **Managed:** no grace. `expires_at` is the node-enforced end, + ≤ 5 s enforcement latency.
- **Legacy node expiry:**
  - expiry = `current_period_end + 72 h`, where `current_period_end` is the maximum over the subscription's base items from a Stripe **retrieve**, never `invoice.lines[0]`;
  - pushed on `invoice.paid` **and** on `customer.subscription.updated`.
- **Terminal cut:** `canceled`, `unpaid`, `deleted`, suspension, device revocation or entitlement loss → explicit `DISABLE_USER` at once, in the next ADR-0004 apply window. Abuse and suspension are urgent.
- **`past_due`:** live until Stripe ends dunning. David to confirm dunning ends in ≤ 14 days.

### C-05 Route directory and refresh — internal + client

- **Server:**
  - TTL 1 h, `issued_at = now`;
  - the version bump is compare-and-swap (F-45);
  - a non-entitled account gets a signed `routes: []`.
- **Client time checks:**
  - accept `issued_at` up to 10 min in the future;
  - accept `expires_at` up to 5 min in the past;
  - beyond that, show an explicit "device clock is wrong" error, never a hang;
  - an unsigned server `Date` header is never used to shift validity.
- **Client refresh:**
  - background refresh while connected at 50 % of the TTL;
  - on failure, reuse the verified directory until it expires;
  - renewal of an existing lease may proceed with an expired local directory (the server validates the route).
- **Client validation:**
  - an invalid single route is skipped and counted;
  - only envelope, signature, schema or rollback failures reject the whole directory;
  - a corrupt version file → `.bak`, else a floor of 0 plus a diagnostic.

### C-06 Two-hop credentials (invariant 2) — internal

- A `privacy_plus` route has exactly 2 hops, `[entry(relay), exit]`, on distinct nodes with distinct IPs. The client rejects equal hop addresses (F-PRIV-02).
- One lease = one slot per hop, in one transaction, with a shared `expires_at = min(valid_until)`. Renew both or neither; revoke both.
- **Entry:** egress only to its declared exits; the only loopback exception is the probe user (E-02).
- **Client:** builds chained configs only and never dials the exit of a 2S route directly. If either hop fails, the route fails → the next 2S candidate, or a visible failure. **Never Fast.**

### C-07 Direct vs 2-hop credential separation — flagged (`REQUIRE_RELAYED_EXIT_SLOTS`)

- Lease slots carry `class ∈ {direct, relayed}` (lease sync v2, C-15).
- Exits render one rule: a user in `relayed` with a source not in the declared relay IPs (v4 and v6) → `reject`.
- Relay IPs reach the exit through the lease-sync response field `relay_sources`. They change only on topology change; that apply counts as a maintenance apply.
- **Class selection in `authorize`:**
  - Fast hop → `direct`;
  - relay hop of a 2S route → `direct` on the relay;
  - exit hop of a 2S route → `relayed`.
- **Legacy documents:** the via route gets its own credential, separate from the Direct credential.
- **Flag off:** 2S uses `direct` slots, which is today's behaviour, and A-08 stays open.

### C-08 Node health — flagged (`REQUIRE_PROTOCOL_PROBE`)

- **Eligible for directory or placement** requires all of:
  - lifecycle READY or CANARY;
  - a heartbeat ≤ 3 min old;
  - a protocol probe ≤ 5 min old, with a self handshake passing for each transport the node advertises.
- A transport that fails → routes using it are withheld; all transports fail → DEGRADED.
- A 2S pair `(R, X)` is eligible only if R's relay-path probe to X passed within the last 10 min.
- Hysteresis stays 3 fail / 5 pass. Probes never mark FAILED; only silence does, and the silence sweep runs in fleet-tick (B-02).
- **Old agents** (no probe data) → "unknown". That is still eligible while the flag is off and ineligible after.
- **Additive heartbeat fields:** `customer_users`, `lease_slots`, `singbox_restarts_total`.

### C-09 Node lifecycle (invariant 7) — internal + agent behaviour

`authenticateNode` requires a valid key **and** lifecycle ∉ {QUARANTINED, RETIRED}.

| State entered | Same transaction | Follow-up |
|---|---|---|
| QUARANTINED | `revoked_at = now`, `api_key_hash = null`; pending/claimed jobs → `cancelled`; lease slots deleted; directory version bumped without the node | DNS removed (fleet op) |
| RETIRED | allowed only if `dns_removed_at` is set, the server is destroyed and assignments = 0 (or an audited override); key revoked | — |
| DRAINING | no new assignments, leases or **renewals** (renewal → `route_stale`) | legacy devices re-placed (C-12) |
| FAILED | out of directory and placement; key stays valid (it may recover) | DNS removed after 24 h unrecovered, or at retire |

Agent on 401: stop claiming and syncing, keep enforcing local lease expiry, back off exponentially.

### C-10 Job leases — additive, then flagged (`REQUIRE_CLAIM_TOKEN`)

- **Claim response:** adds `claim_token` (uuid) and `lease_expires_at = now + 10 min`.
- **Complete/fail:**
  - must echo `claim_token`;
  - accepted only while the job is `claimed`, the token matches and the lease is current;
  - otherwise `409 stale_claim`;
  - a missing job → `410 job_gone` (was 404);
  - a cancelled job → `409 job_cancelled`.
- **Agent:** 404, 409 and 410 on complete/fail are terminal: drop the result and log.
- **Reaper** (fleet-tick, every minute):
  - an expired claim → `pending`, `attempts + 1`;
  - `attempts ≥ 5` → `failed` + an alert.
- **Transition:** tokenless completes from old agents are accepted until the flag flips.

### C-11 Job retry, idempotency, ordering, cancellation — additive

- State-sync jobs use deterministic keys: `<kind>:<vpn_account_id>:<desired_version>`. Never `Date.now()` or random values.
- Enqueuing a desired state for user U sets older `pending` jobs for U → `cancelled`.
- **Node:** `vpn-admin` receives `--job-id` and `--idempotency-key`.
  - `CREATE_USER` with a seen key returns the existing user.
  - A mutation of U with a job id below U's last applied id exits `65` ("superseded"). The agent reports that as done with `{"superseded": true}`.
- **Timeouts:** the child is killed and reaped before any retry. Retries happen only on `75` (busy) or a transient failure.
- **Batching:** non-urgent mutations are coalesced into the ADR-0004 apply window.

### C-12 Control-plane failover — internal

- FAILED, DRAINING or QUARANTINED → the node is removed from the next directory version immediately.
- Legacy devices on that node are re-placed make-before-break within 2 ticks:
  1. `CREATE_USER` on the target node, and wait for `done`;
  2. switch the assignment and subscription document;
  3. `DISABLE_USER` on the old node if it is reachable.
- Managed clients move through renewal refusal and C-13.
- Auto-replace stays opt-in.

### C-13 Client route failover (invariants 2 and 6) — client

- **Triggers:**
  - a dial failure;
  - the Core exits;
  - 3 status failures;
  - the node cuts the tunnel after a failed renewal.
- **Order:**
  1. the same route once, while its lease is usable;
  2. the other same-mode candidates, by priority, preferring failure domains that have not failed yet.
- **Limits:** ≤ 6 dials per attempt; between attempts, backoff from 5 s to a 5 min cap while the user's intent is still "connected".
- **Throughout:**
  - the Windows block stays armed (daemon `replace-runtime`);
  - the UI shows "Reconnecting" + Restore Internet.
- **Never:**
  - a mode change;
  - dialing the exit directly for 2S;
  - releasing the block for a switch.

### C-14 Stripe ordering and idempotency (invariant 8) — internal

- Every `customer.subscription.*` and `invoice.*` handler retrieves the subscription (items expanded) and writes that snapshot.
- The write happens only if `retrieved_at > subscriptions.stripe_synced_at`, as a conditional update.
- `canceled` is sticky: never overwritten by a non-canceled state.
- Event-id dedupe stays.
- A retrieve failure returns 500, so Stripe retries.
- `checkout.session.completed` validates the base price (C-04).

### C-15 Lease sync v2 (invariants 4 and 5) — additive

- **Request:** `"protocol": 2`, and a `class` per slot.
- **Response:** may carry `extend_to` for `active` slots as well as `leased` ones.
- **vpn-web:** sets `extend_to` for an `active` slot when `valid_until − now < min_remaining + 2 × grid`. In the same statement it sets DB `valid_until = extend_to`, so a lease granted meanwhile can never outlive what the node will enforce. If adoption is late, the credential ends early: a liveness issue, never a security issue.
- **Agent:**
  - adopts `extend_to` for `active` and `leased` current-generation slots (never backwards, floored to the grid, capped at `now + lifetime`), with a byte-identical render and **no restart**;
  - v2 slots never rotate for "unleased past window";
  - a secret's generation age is capped at 24 h, and those rotations are batched into one apply inside the node's maintenance window (default 04:00 UTC, configurable).
- **Protocol-1 agents:** unchanged.

### C-16 Data-plane egress policy (invariant 3) — node

**Rule set.** Rendered for every user on exits, and on relays behind the existing allow-list. `resolve` runs **before** the IP rules, so a domain is judged by its resolved address.

- Reject IPv4:
  - `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`;
  - `192.0.0.0/24`, `192.0.2.0/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`;
  - `224/4`, `240/4`.
- Reject IPv6: `::/128`, `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`, `100::/64`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and `fd00:ec2::254`.
- Reject the node's own public v4 and v6 addresses on every port.
- Reject TCP/25.

**Exceptions.** Only the probe user may reach its declared probe targets and the relay self-test. No exception exists for customers or `lease-*` users.

**Host layer (defence in depth).**

- nftables output rules for `meta skuid sing-box` reject the same set.
- Allowed are only the configured resolvers on :53 (and :853 if DoT) plus established inbound replies.

**Self-host single VPS.** The same default applies. The only opt-out is `allow_private_egress = true`: explicit, documented, and off by default.

### C-17 Client fail-closed recovery (invariant 6) — client

- **Account states:** `signedOut`, `signedInOnline`, `signedInOffline` (refresh token present; control plane unreachable, 5xx or timing out), `sessionInvalid` (401/403).
- **Blocked state:** a residual WFP block is surfaced app-wide on every screen and in every state.
- **Restore Internet:**
  - local only: an owner-authorized daemon release through the same-signer controller;
  - needs no network.
- **Connect under block:** offered only if a verified directory is valid **and** (a usable lease exists **or** authorize is reachable). Otherwise it is hidden, with an explanation.
- **Launch:** never awaits the network. The shell renders within 2 s; managed loading and errors show in place, with retry and backoff.
- **Deferred to a tamara ADR in wave 3:** an app-bound WFP permit for the control-plane origin. Default: none.

---

## 4. ADR-0004 (to be written by CONTRACT in vpn-web `docs/ADR/`, cross-linked from singbox-vpn): node-wide restarts

**Fact.** Stock sing-box 1.14.1 has no runtime user API (NEW-03). Every credential change is a restart that cuts every connection, and a SIGHUP is no cheaper (ADR-0003 measurement).

**Decision (proposed — David to accept).**

**T — transitional, now:**

1. C-15: idle slots extend in place, removing the P0 restart source (A-03).
2. Renewal is already restart-free.
3. Every non-urgent change (legacy create/enable/disable, expiry reconcile, lease expiry and non-urgent revocation) is coalesced into **one apply per window**. Default 30 min, configurable 10–60 min.
4. Urgent applies (abuse, suspension, quarantine) happen immediately.
5. Customer-triggerable restarts are removed (A-05).
6. Clients reconnect transparently after an apply (C-13).

**Security cost:** a non-urgent revocation or expiry can outlive its time by at most one window. Lease `expires_at` stays node-enforced; lease-expiry rotations are batched only when the expired slot has no holder renewing it, which is exactly the "user went away" case.

**L — long term, spike before adoption:** a server-side sing-box patch adding a root-only Unix-socket control API.

- It calls `UpdateUsers` on live VLESS and Hysteria2 inbounds, with the user map made atomic (fixing the unsynchronized swap).
- It closes the open connections of removed users via the router's connection tracker.
- It is shipped as a provenance-pinned build (G-11) behind `CompatibilityBackend`.

**Adoption criteria** (VPS tier), all required:

- add/remove 100 users/min for 1 h with 50 long-lived flows from other users → 0 dropped;
- a removed user's open flows are closed within 2 s;
- `go test -race` is clean;
- the maintenance burden is accepted by David (a forked patch to rebase on every sing-box bump).

If L is rejected, T is the permanent architecture and invariant 5 is documented as "bounded, not zero".

---

## 5. Parallel vs sequential

### Hard sequencing (a → b means b needs a merged or frozen)

1. J-04 (real-schema SQL tests in CI) → the regression tests of every vpn-web C/D item land on top of it.
2. C-01 `device_entitlement()` (CP-BILL) → wired into `lease_route_slots` (CP-FLEET, wave 2) → C-06 suspend → A-06 grace.
3. C-10 server side (vpn-web) ∥ D-04/D-05 agent side (contract frozen) → **deploy** vpn-web → agents → flip `REQUIRE_CLAIM_TOKEN`.
4. C-15 server side → C-15 agent side → A-03 closed → C-07 slot classes → A-08 → flip `REQUIRE_RELAYED_EXIT_SLOTS`.
5. E-01 renderer → E host nft layer → E-03 Unix socket → E-04 (same files, one owner).
6. F-02 → F-01 → A-01/A-02 → B-06 → F-03 (same client files, one owner).
7. B-01 probes on → B-02/B-03 failover → B-04 relay path → flip `REQUIRE_PROTOCOL_PROBE`.
8. D-01 key revocation → D-02 DNS on retire → B-03 re-placement before retire.
9. G-01 before any VPS acceptance run. G-02 needs the singbox release to publish the `install.sh` hash.
10. ADR-0004 spike → A-04 final. The transitional part of A-04 needs C-11.

### Waves

| Wave | Runs in parallel (disjoint files) |
|---|---|
| **1 (now)** | NODE-DP: E-01, E-02 · NODE-AGENT: D-04, D-05 (agent side of C-10/C-11) · SUPPLY: G-01, G-05 (singbox), G-03, G-04 (tamara) · CP-BILL: J-04, C-01, C-02, C-03, C-04, A-05 · CP-FLEET: D-01, D-02, D-03 + C-10 server, B-02 · CLIENT: F-02, F-01, then A-01, A-02 |
| **2** | NODE-AGENT: A-03 (C-15 agent), B-01 defaults, B-07 · CP-FLEET: A-03 (C-15 server), B-01 gating + bootstrap, B-03, G-02, H-01, entitlement wiring into the RPC · NODE-DP: nft layer, E-03, E-04, C-07 exit rules · CLIENT: B-06, H-03, H-04, A-07, F-03 · CP-BILL: C-05, C-06, A-06, C-07 (app), C-09 · CONTRACT: ADR-0004 + spike, canonical contract docs · SECQA/RELQA: verify wave 1 |
| **3** | A-08, B-04, A-04 (transitional), A-09, D-06…D-10, H-02, H-05, J-02, J-03, J-05, K-* |
| **4** | Production acceptance (§7.3) |

---

## 6. Roles, branches and file ownership

| Role | Agent | Responsibility |
|---|---|---|
| COORD | this session | plan, matrix, reviews, PRs, approvals |
| CONTRACT | API/contract owner | §3/§4 → canonical docs; sole writer of contract files |
| CLIENT | client owner | tamara-next app + daemon overlay |
| CP-BILL | control plane: billing/entitlement/account | vpn-web |
| CP-FLEET | control plane: fleet/agent API/leases/routes | vpn-web |
| NODE-DP | node data plane (renderer, firewall, subscription svc) | singbox-vpn |
| NODE-AGENT | provisioning agent + `vpn-admin` job paths | singbox-vpn |
| SUPPLY | supply chain / release engineering | all |
| SECQA | infra/security QA — independent verification | all |
| RELQA | performance/reliability QA — independent verification | all |

The implementer writes the regression test first; the test owner re-verifies independently before sign-off.

### Branches (base `origin/main` of each repo)

| Repo | Branch | Owner | Items |
|---|---|---|---|
| vpn-web | `remediation/program-2026-09-27` | COORD | this plan |
| vpn-web | `remediation/cp-billing-entitlement` | CP-BILL | J-04, C-01…C-04, A-05 |
| vpn-web | `remediation/cp-fleet-node-trust` | CP-FLEET | D-01…D-03, C-10 server, B-02 |
| singbox-vpn | `remediation/node-dp-egress-isolation` | NODE-DP | E-01, E-02 |
| singbox-vpn | `remediation/node-agent-job-safety` | NODE-AGENT | D-04, D-05 |
| singbox-vpn | `remediation/supply-singbox-pin` | SUPPLY | G-01, G-05 |
| tamara-next | `remediation/client-launch-session-recovery` | CLIENT | F-02, F-01, F-TEST-01 |
| tamara-next | `remediation/client-lease-renewal` (on the previous) | CLIENT | A-01, A-02 |
| tamara-next | `remediation/supply-go-toolchain` | SUPPLY | G-03, G-04 |
| all three | `remediation/contracts-v1.1` (wave 2) | CONTRACT | canonical contract docs + ADR-0004 |

### Exclusive file ownership (wave 1)

- **CONTRACT only:**
  - tamara-next `docs/contracts/**`;
  - vpn-web `docs/ADR/**`;
  - singbox-vpn `docs/PROVISIONING_CONTRACT.md`, `docs/ADR/**`, `crates/provisioning-contract/**`.

  Implementers read §3 of this file; they do not edit contract docs.
- **CP-BILL:**
  - `functions/lib/{subscriptions,device-assignment,device-provisioning,stripe-events,stripe-fields,account-service,provision-entitlement,identity-lifecycle,accounts}.js`;
  - `functions/api/{vpn,account,billing,telegram}/**`, `functions/api/{stripe-webhook,create-checkout-session,cancel-subscription,resume-subscription}.js`;
  - `functions/v1/{subscriptions,devices,account}/**`, `functions/v1/entitlement.js`;
  - `supabase/tests/**`, `.github/workflows/ci.yml`;
  - migrations `20261001*`.
- **CP-FLEET:**
  - `functions/lib/{node-*,fleet-*,dns*,dns/**,scheduler,route-*,vpn-authorize,protocol-health*,resolve-node,admin-fleet,admin-sanitize}.js`;
  - `functions/api/agent/**`, `functions/api/internal/**`, `functions/api/admin/{nodes,fleet,jobs}*/**`;
  - `functions/v1/{routes.js,vpn/**}`;
  - migrations `20261002*`.

  CP-FLEET adds SQL tests as **new** files in `supabase/tests/`.
- **NODE-DP:** `crates/compat-config/**` (except `provisioning-contract`), plus new tests.
- **NODE-AGENT:** `apps/provisioning-agent/**`, `apps/admin/src/{lock.rs,main.rs,lease_pool.rs}`.
- **SUPPLY:**
  - singbox `deploy/almalinux/{install,update}.sh` (sing-box download functions only), `deploy/lib/tests/**`, `.github/workflows/**`;
  - tamara `native/boxddctl/go.{mod,sum}`, `.github/workflows/**`, `tool/build_*`.
- **CLIENT:** tamara `lib/**`, `test/**`, `core/**` (overlay).
- **Migration timestamp bands** (latest existing: `20260930010000`):
  - CP-BILL `20261001xxxxxx`;
  - CP-FLEET `20261002xxxxxx`;
  - wave-2 lease v2 `20261003xxxxxx`;
  - privacy/retention `20261004xxxxxx`.

  Nobody edits an existing migration.

### Merge policy

- Every branch → a PR with its evidence. The test owner signs off.
- **Merging to `main` is David's decision**, because:
  - vpn-web `main` may deploy to Cloudflare Pages;
  - migrations must be applied to production Supabase first (a production write);
  - singbox tags are releases.
- Agents commit locally; COORD pushes branches and opens draft PRs.

---

## 7. Test strategy

**Rule:** every P0/P1 item gets a regression test that fails on today's `main` (reproduce first), committed with or before the fix. The audit repro artifacts are reused:

- tamara `test/audit/production_readiness_audit_test.dart`: cherry-picked, each assertion inverted when fixed;
- singbox `docs/reviews/evidence/2026-09-27/*`;
- web report Appendix A/B, turned into committed tests.

**A mocked test does not satisfy an acceptance criterion whose property is network behaviour**: E-*, A-08, A-03/A-04 restart counts, H-03, H-08, F-03, B-01 final.

### 7.1 Tiers

| Tier | Where | What |
|---|---|---|
| unit | each repo CI | vitest, `cargo test --locked`, `flutter test` (hermetic, F-TEST-01 fixed) |
| integration | local | vpn-web on Postgres 16 with Supabase roles (replayed migrations); agent binary against local Functions (`wrangler pages dev`) + local DB |
| protocol | WSL2 netns lab (IPv4 + IPv6) | real sing-box 1.14.1 servers rendered by `vpn-admin`; clients from tamara's `SingBoxConfigBuilder`; metadata simulator on `169.254.169.254` / `fd00:ec2::254`; pcaps per hop; soak with restart counter |
| VPS | disposable hosts (≥ 2 providers for 2S) | `vps-acceptance.yml` + new stages: isolation suite, 24 h soak, relay→exit probes, real metadata endpoint, DNS removal |
| device | Windows hardware (then Apple) | B15 qualification incl. reboot, switch-under-block, IPv6/DNS leak |
| production-read-only | David runs | web report §22 queries 1–10; `dig` of retired hostnames; `/version`; public endpoint probes |

### 7.2 Cross-repo acceptance matrix

| Item | unit | integration | protocol | VPS | device | prod-RO |
|---|---|---|---|---|---|---|
| C-01 capacity | ✔ repro inverted | ✔ `device_entitlement` SQL property test | — | — | — | query 8 |
| C-02 Stripe order | ✔ permutations | ✔ Stripe CLI test-mode replay | — | — | — | subscription status vs Stripe diff (read) |
| A-01 renewal | ✔ expiring fakes | ✔ client ↔ local vpn-web | ✔ 3 h session, PID + stream | ✔ 3 h on real node | ✔ Windows 3 h | — |
| A-03 idle churn | ✔ rotation sim (audit) | ✔ agent ↔ local sync | ✔ 24 h soak restart count | ✔ 24 h soak | — | journal restart count (read) |
| A-04/A-05 restarts | ✔ | ✔ rate-limit tests | ✔ churn soak | ✔ | — | — |
| A-08 separation | ✔ renderer | ✔ class leasing | ✔ **required** | ✔ 2 providers | — | — |
| B-01/B-04 health | ✔ | ✔ READY gating | ✔ break decoy/cert/443 | ✔ **required** | — | node states (read) |
| B-02/B-03 failover | ✔ | ✔ real schema | — | ✔ kill agent/node | — | — |
| D-01 key revoke | ✔ enumerated routes | ✔ | — | ✔ quarantined node gets 401 | — | query 9 |
| D-02 DNS | ✔ | ✔ | — | ✔ | — | `dig` retired names |
| D-03/D-04/D-05 jobs | ✔ | ✔ agent ↔ local CP (404/timeout/lock) | — | ✔ | — | query 7 |
| E-01/E-02 isolation | ✔ renderer | — | ✔ **required**, v4 + v6 + DNS names | ✔ real metadata | — | — |
| F-01/F-02 recovery | ✔ audit tests inverted | — | — | — | ✔ **required** reboot | — |
| F-03 switch | ✔ | — | ✔ pcap (Linux daemon) | — | ✔ **required** pcap | — |
| G-01…G-04 supply | ✔ poisoned sums, tidy diff | ✔ CI | — | ✔ install from pinned | — | — |
| H-01 plaintext URLs | ✔ | ✔ | — | — | — | query 6 |
| H-03/H-08 DNS/IPv6 | ✔ config | — | ✔ **required** | ✔ | ✔ **required** | — |

### 7.3 Production acceptance (wave 4)

Every step is read-only unless marked. Every "(approval)" step waits for David.

1. §22 queries 1–10 pass (0 plaintext URLs, 0 stuck claims, 0 unentitled active devices, RLS on).
2. `/version` equals the merged SHAs; migrations current.
3. 2 disposable nodes pass VPS acceptance plus a 24 h soak with ≤ 1 restart (maintenance window).
4. Windows device B15 run with no FAIL.
5. Legal pages final (J-01).
6. (approval) Deploy vpn-web and migrations → upgrade agents → flip `REQUIRE_CLAIM_TOKEN`, `REQUIRE_PROTOCOL_PROBE`, `REQUIRE_RELAYED_EXIT_SLOTS`.
7. (approval) One-off purge (H-01), dangling-DNS deletion (D-02), key revocation of already-retired nodes (D-01).
8. Closed beta.

---

## 8. Needs David

| # | Decision / action | Why it is yours |
|---|---|---|
| 1 | Disposable VPS access: a scoped Hetzner project token, or 2–3 disposable AlmaLinux 9 hosts (2 providers for 2S) | VPS tier is blocked without it; I will not use the unlabelled `~/.ssh/vps_key` host |
| 2 | Run §22 production read-only queries (or grant read-only access) | the earlier audit session was blocked; production access |
| 3 | Merge/deploy policy: does vpn-web `main` auto-deploy to Pages? | merging may equal a production deploy |
| 4 | Accept ADR-0004 T now; approve the L spike (patched sing-box) or not | long-term maintenance cost |
| 5 | Stripe: dunning ≤ 14 days; Stripe Tax; WAF rate-limit rules | production Stripe/Cloudflare changes |
| 6 | Legal text (Terms, Privacy, Impressum) | legal |
| 7 | Launch platforms: Windows only first? | decides whether F-04/F-05 are blockers |
| 8 | Branch/tag protection rulesets on all three repos | repository governance |
| 9 | Key escrow + first rotation of `VPN_SECRETS_ENCRYPTION_KEY` / route-signing key | production key rotation |
