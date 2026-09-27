# Arcana web / control plane — production readiness audit

Date: 2026-09-27
Repository: `David610/vpn-web`
Audited commit: `main` = `6b3828e91a8fa41da59ee5993bd37091cf77724f`
Related repositories (read-only): `David610/singbox-vpn` at `5cee2fa3b2`, `David610/tamara-next` at `a57060b70f`
Scope: security, privacy, reliability, performance of the web app, Cloudflare Pages Functions, Supabase schema, Stripe billing, fleet control plane, agent API, Telegram, admin.

This audit did not rely on earlier "production ready" claims. Every finding below says whether it was
**Verified** (reproduced by a test, a database replay, a browser run, or direct reading of the exact code path
including the other repository) or **Inferred** (follows from code but depends on external behaviour I could
not observe, for example Stripe timing or hosted Supabase settings).

No production data was changed. No migration was applied. No secret was rotated. No Stripe, Cloudflare,
DNS, Telegram or node action was taken.

---

## 1. Executive summary

**Verdict: not ready to take real payments.** The code base is careful in many places (Stripe signature
checks, RLS on every table, SECURITY DEFINER functions locked to `service_role`, admin behind `aal2`, a
well-built lease-pool RPC, idempotent Stripe/job keys). But there are real defects that a paying service
cannot ship with:

1. **Device capacity can be bypassed.** A customer with one €6.99 subscription (3 devices) can get working
   VPN credentials for more devices. Reproduced in a test. (F-01, P0)
2. **Out-of-order Stripe webhooks can bring a cancelled subscription back to `active`** (and set wrong pack
   counts). Reproduced in a test. (F-02, P1)
3. **The production legal gate does not work.** The live site at `arcana-web-epw.pages.dev` serves draft
   Terms/Privacy ("structural draft") and an Impressum with `[Company or sole-proprietor legal name]`.
   (F-03, P0 for launch)
4. **Plain-text VPN setup URLs are stored in `provisioning_jobs.result`**, which defeats the AES-GCM
   encryption of `vpn_secrets`; one of the two URLs is also shown to every admin, including read-only ones.
   (F-04, P1)
5. **Node credentials are never revoked.** Quarantining or retiring a node does not stop its agent from
   authenticating, claiming jobs or syncing leases. There is no key revocation/rotation API. (F-05, P1)
6. **Retired nodes leave DNS records behind** (`deleteRecord` exists but nothing calls it). The released
   IP can be taken over and serve configs to legacy clients that still refresh
   `https://<node>.<domain>:8443/sub/...`. (F-06, P1)
7. **Admin "disable user" is broken and not durable**: it returns 500 for any customer with more than one
   VPN identity (reproduced) and the next reconcile re-enables what it disabled. (F-07, P1)
8. **Account deletion is not atomic**: it bans the user first, then cancels Stripe subscriptions in a loop.
   One Stripe error leaves a banned user who is still billed and cannot log in to fix it. (F-08, P1)
9. **Claimed jobs are never re-queued.** A crashed agent strands jobs in `claimed` forever and blocks future
   `CREATE_USER` for that device/node through a unique index. (F-09, P1)
10. **Any customer can repeatedly restart sing-box on their node** (credential rotation, profile changes,
    device add/remove), which drops every user's connections on that node. There is no rate limit.
    (F-10, P1)

**Production state was only partly verifiable.** The deployed frontend is older than `main` (verified by
comparing build chunks). The deployed API has the recent protocol-health routes. `GET /api/locations` on
production returns `{"locations":[]}`, so no enabled location has a READY node right now. My read-only
queries against the production Supabase project were blocked by this session's safety classifier, so the
production migration state, auth settings and RLS exposure are **not verified**. Section 22 lists the exact
read-only checks for you to run.

Counts: **no verified hole that gives an outsider another customer's data or admin access**; 52 findings in
total: **2 P0** (capacity bypass, legal gate), **16 P1**, **21 P2**, **13 P3**. See section 23.

---

## 2. Current commit and baseline

| Check | Command | Result |
|---|---|---|
| Branch/commit | `git log`, `git rev-parse HEAD` | `main` = `6b3828e91a8fa41da59ee5993bd37091cf77724f` (matches the prompt's `6b3828e91a`). Working tree clean. |
| Install | `npm ci` | **Fails** with `ERESOLVE` (`@types/node@^20` vs the `vitest@5` peer range `^22` or `>=24`). Works only with `--legacy-peer-deps`, which is what CI uses. |
| Unit tests | `npm test` | **775 passed, 73 files**, 5.7 s. |
| Lint | `npm run lint` | 0 warnings, **but `next lint` does not lint `functions/` or `scripts/`**. `npx eslint functions scripts` → 0 errors, 9 warnings (unused vars). |
| Build | `npm run build` | OK, 41 static pages. Home First Load JS 172 kB, shared 103 kB, `/telegram` 107 kB. |
| Dependency audit | `npm audit --omit=dev` and `npm audit` | 0 vulnerabilities. |
| a11y/visual | `node scripts/a11y-visual-check.mjs` (with the preinstalled Chromium) | 22 pages × 7 viewports = 154 renders, **0 findings**. |
| Migrations | replayed all 37 files on PostgreSQL 16 with Supabase-like roles and default grants | **All apply cleanly** on an empty DB. |
| SQL tests (`supabase/tests/*.sql`) | ran against the replayed schema | `subscription_devices_test` passes. `rls_test.sql` **fails** (queries `subscriptions.user_id`, dropped in `20260922120000`). `ephemeral_lease_pool_test.sql` **fails** (inserts `nodes` without the NOT NULL `lifecycle_state`); with that one fix it passes. CI never runs these files. |
| Migration CI scripts | `scripts/test-*.sh` | Not run here (they call `sudo systemctl`); they run in CI. |
| Repro tests (scratch, not committed) | vitest against `fake-supabase.js` | 4/4 findings reproduced (F-01, F-02, F-07, F-12). |
| DB simulation | lease pool exhaustion SQL | Reproduced (F-11). |
| Browser | Playwright + Chromium on the static build | Open redirect reproduced (F-14); performance numbers in section 14. |

---

## 3. Production architecture (system map)

```
Browser (Next.js static export, session in localStorage "arcana-auth-v1")
  │  HTTPS, Supabase JS (anon key, PKCE)            ──► Supabase Auth (GoTrue)
  │  HTTPS, Bearer <Supabase access token>
  ▼
Cloudflare Pages (static)  +  Pages Functions (/api/*, /v1/*)   [one origin: public site + account + admin]
  │  service-role key (bypasses RLS) — every Function
  ├──► Supabase PostgREST / RPC (Postgres 17)           tables: 37, all RLS on
  ├──► Supabase Auth admin API (ban, delete, password)
  ├──► Stripe API (checkout, portal, subscription update/cancel)
  ├──► Resend (alert email, hard-coded recipient)
  ├──► Hetzner Cloud API (create/destroy servers)       [fleet-tick, admin]
  ├──► Cloudflare DNS API (upsert A record)             [fleet-tick, admin]
  └──► node HTTPS :8443 / TCP :443 (readiness probe)    [fleet-tick]

Stripe ──(signed webhook)──► /api/stripe-webhook ──► subscriptions, provisioning_jobs
Supabase pg_cron + pg_net ──(X-Fleet-Tick-Secret, every minute)──► /api/internal/fleet-tick
Node agent (singbox-vpn provisioning-agent, Bearer node API key)
   ──► /api/agent/{claim,jobs/:id/complete|fail,heartbeat,traffic,leases/sync,
                   bootstrap-status,probe-credential,probe-targets,revision/:n}
   ◄── jobs: CREATE_USER / SET_EXPIRY / CLEAR_EXPIRY / ENABLE / DISABLE / ROTATE_* / APPLY_NODE_REVISION
   node applies via vpn-admin → sing-box reload-or-restart (drops all connections)
Telegram client ──(X-Telegram-Init-Data, HMAC with bot token)──► /api/telegram/*
tamara-next app ──(Bearer Supabase token obtained via /v1/auth/login proxy)──► /v1/*
   /v1/routes (Ed25519-signed directory) → /v1/vpn/authorize (lease slot per hop)
```

| Edge | AuthN | AuthZ | Trust boundary | Data stored | Retry | Rate limit | Failure behaviour |
|---|---|---|---|---|---|---|---|
| Browser → Supabase Auth | password / PKCE | GoTrue | internet → Supabase | session in localStorage | SDK auto-refresh | GoTrue per-IP | login fails |
| Browser → Functions | Bearer JWT, `getClaims` | app code, service role | internet → Worker | — | none | **none in app** | 401/403/500 JSON |
| App → `/v1/auth/*` → GoTrue | password proxied | GoTrue | internet → Worker → Supabase | device row per session | none | **GoTrue sees Worker egress IP** | 401/503 |
| Functions → Postgres | service-role key | none (RLS bypassed) | Worker → Supabase | everything | none | none | throws → 500 |
| Stripe → webhook | `Stripe-Signature`, 300 s tolerance | event handlers | Stripe → Worker | `stripe_events` (full payload) | Stripe retries on non-2xx (≈3 days) | none | 500 → retry |
| pg_cron → fleet-tick | static shared secret | — | Supabase → Worker | — | every minute | none | logged only |
| Agent → `/api/agent/*` | SHA-256(node key) lookup, `revoked_at` only | job/node id scoping | node → Worker | telemetry, leases, results | agent retries | **none** | 401/500 |
| Telegram → `/api/telegram/*` | initData HMAC, 24 h read / 1 h write | `telegram_links` → user | Telegram → Worker | link rows | none | none | 401/403 |
| Functions → Hetzner/Cloudflare DNS | API tokens | — | Worker → provider | node rows | 8 attempts, backoff | none | op FAILED |
| Functions → Stripe | secret key | — | Worker → Stripe | subscription mirror | **no idempotency keys**, no timeout | none | 500/502 |

---

## 4. Threat model

Assets: customer accounts and payment relationship, VPN credentials (subscription URLs, lease slots), node
fleet (API keys, provider/DNS tokens), route-signing key, `VPN_SECRETS_ENCRYPTION_KEY`, admin sessions,
customer metadata (email, Telegram id, device names, connection times).

Actors considered:

- **Anonymous internet user** — can sign up for free, call every public endpoint, read the static site.
- **Paying customer acting in bad faith** — wants more devices, free service, or to disturb others.
- **Legacy account "member"** (pre-ADR-0001 shared accounts).
- **Compromised node / agent** — has one node's API key and root on that VPS.
- **Stolen customer session / refresh token** (localStorage, app).
- **Stolen admin session.**
- **Network adversary / censor** — wants to enumerate and block nodes.
- **Infrastructure failure** — Stripe, Supabase, Cloudflare, Hetzner, Telegram outages; duplicate cron; late webhooks.

---

## 5. Authentication and authorization

### 5.1 How authentication works

- **Customer (web)**: Supabase JS in the browser, PKCE, session (access + refresh token) in `localStorage`.
  Functions check `Authorization: Bearer` with `supabase.auth.getClaims()` (`functions/lib/user-auth.js`).
  `getClaims` verifies the JWT locally with JWKS for asymmetric keys, or calls `getUser()` for HS256 keys.
  It does not check `aud`/`iss`. Access tokens without `sub` (anon/service keys) are rejected.
- **Recent auth**: `requireRecentUser` requires a human AMR entry (`password`, `otp`, `recovery`, …) in the
  last 15 minutes. Good design; fails closed without AMR.
- **App (`/v1`)**: same JWT, obtained through the `/v1/auth/login` proxy. `/v1` never requires recent auth.
- **Admin**: same JWT + row in `admin_users` + `aal == "aal2"`. Read-only role blocked on writes.
- **Agent**: `Bearer <node api key>`, looked up by SHA-256 hash, only `revoked_at` is checked.
- **Telegram**: HMAC-verified `initData`, 24 h for reads, 1 h for writes, mapped through `telegram_links`.
- **Fleet tick**: static shared secret header, constant-time compare.
- **Stripe**: `constructEventAsync` with WebCrypto on the raw body.

### 5.2 Endpoint inventory

Legend — Class: P public, C customer JWT, R customer JWT + recent auth (15 min), A admin (aal2), N node key,
T Telegram initData, S shared secret, W Stripe signature. "Owner" means the code checks `account_members.role
= 'owner'`. "Acct" means the object's `account_id` is compared with the caller's account. RL = application
rate limit. Audit = row in `admin_audit_log`.

| Route | Class | Object ownership check | Role check | RL | Idempotent / replay | Audit | Notes |
|---|---|---|---|---|---|---|---|
| GET `/api/locations` | P | — | — | CDN cache 300 s | read | — | service role; returns `[]` in prod |
| POST `/api/stripe-webhook` | W | — | — | — | event id dedupe | — | no ordering guard (F-02) |
| POST `/api/create-checkout-session` | R | account | owner | — | trial reservation RPC | — | no Stripe idempotency key |
| POST `/api/billing/portal` | R | account | owner | — | — | — | |
| POST `/api/cancel-subscription` (legacy) | R | account | **none** | — | — | — | `.maybeSingle()` breaks with ≥2 live subs; unused by UI |
| POST `/api/resume-subscription` (legacy) | R | account | **none** | — | — | — | same |
| GET `/api/account` (legacy) | C | own account via RPC | — | — | read | — | returns legacy seats/members shape; unused by UI |
| GET `/api/account/overview` | C | own account | — | — | read | — | |
| GET `/api/account/devices` | C | own account | — | — | read | — | includes revoked devices |
| POST `/api/account/devices` | R | profile acct | — | — | none | — | 60-device cap here only |
| PATCH `/api/account/devices/:id` | R | device acct | **none** | — | — | — | rename / move |
| POST `/api/account/devices/:id/revoke` | R | device acct | owner or self | — | status CAS | — | |
| POST `/api/account/devices/:id/assignment` | C | device + profile acct | owner or self | — | `Date.now()` keys | — | **F-01** capacity bypass |
| GET/POST `/api/account/connection-profiles` | C / R | own account | — | — | max 20 | — | |
| PATCH/DELETE `/api/account/connection-profiles/:id` | R | profile acct | **none** | — | — | — | |
| PATCH `/api/account/subscriptions/:id` | R | sub acct | **none** | — | — | — | rename |
| POST `/api/account/subscriptions/:id/packs` | R | sub acct | **none** (F-12) | — | no Stripe idem key | — | charges card |
| POST `/api/account/subscriptions/:id/cancel`, `/resume` | R | sub acct | **none** (F-12) | — | — | — | |
| POST `/api/account/delete` | C + password | own account | owner | — | not atomic (F-08) | — | |
| POST `/api/account/password` | R | self | — | — | — | — | other sessions not revoked (F-22) |
| GET `/api/account/telegram`, POST `link-code` (R), `unlink` (R) | C/R | self | — | — | codes single-use | — | |
| POST `/api/account/accept-invite` | C | invite hash + email match (DB trigger) | — | — | RPC with row lock | — | legacy; all invites revoked |
| POST `/api/account/invites`, `/seats` | — | — | — | — | — | — | return 410 |
| DELETE `/api/account/invites/:id` | R | acct | owner | — | — | — | legacy |
| DELETE `/api/account/members/:id` | R | acct | owner or self | — | — | — | legacy |
| GET `/api/vpn/config` | C | device acct; owner or self | — | — | read | — | gate is **account-level** entitlement (F-01) |
| POST `/api/vpn/rotate-credentials` | R | own newest identity | — | **none** | random key per call | — | unused by UI; restart vector (F-10) |
| GET `/api/vpn/usage` | C | own newest identity | — | — | read | — | no data producer (dead) |
| POST `/v1/auth/login`, `/register`, `/refresh` | P | — | — | **none** (F-13) | — | — | login creates a device row every time |
| POST `/v1/auth/logout` | C | own session device | — | — | — | — | |
| GET `/v1/account`, `/v1/entitlement`, `/v1/routes` | C | own account | — | — | read | — | routes open to any free account (F-26) |
| POST `/v1/vpn/authorize` | C | per-device entitlement | — | 20/device, 60/account per 10 min (RPC) | `client_request_id` | — | good design; pool exhaustion (F-11) |
| PATCH/DELETE `/v1/devices/:id`, PATCH `/current` | C | device acct | **none** | — | — | — | not recent-auth |
| POST `/v1/subscriptions` | R (forwarded) | account | owner | — | — | — | |
| PATCH `/v1/subscriptions/:id`, PUT `/packs`, POST `/cancel` | C | sub acct | **none** | — | — | — | charges card without recent auth |
| POST `/v1/account/delete` | C + password | own account | owner | — | not atomic | — | |
| `/api/telegram/*` (overview, profiles, devices, move, assignment, unlink, me) | T | same services as web | owner/self where the service checks it | — | — | — | assignment shares F-01 |
| POST `/api/telegram/link` | T + code | code hash | — | — | code CAS, single use | — | |
| GET `/api/admin/*` (overview, customers, customers/:id, subscriptions, jobs, audit, alerts, abuse, nodes, settings, fleet/*) | A | — | any admin role | — | read | — | readonly sees all PII |
| POST `/api/admin/customers/:id/{disable,enable,rotate,rotate-credentials}` | A | — | not readonly | — | `Date.now()`/uuid keys | yes | legacy single-identity model (F-07) |
| POST `/api/admin/customers/:id/grant`, DELETE `/api/admin/entitlements/:id` | A | — | not readonly | — | — | yes | |
| POST `/api/admin/nodes`, PATCH `/nodes/:id/lifecycle`, POST `/nodes/:id/replace`, `/revisions` | A | — | not readonly | — | lifecycle CAS | yes | `/revisions` always fails (F-17) |
| POST `/api/admin/jobs/:id/retry`, PATCH `/alerts/:id`, `/abuse/:id` | A | — | not readonly | — | — | yes | |
| POST `/api/agent/enroll` | enrollment token | token hash, 1 h TTL, one key | — | — | idempotent same key | — | |
| POST `/api/agent/claim` | N | own node's jobs | — | — | SKIP LOCKED | — | no stale-claim recovery (F-09) |
| POST `/api/agent/jobs/:id/complete`, `/fail` | N | job.node_id | — | — | done/failed guard | — | stores plaintext URLs (F-04) |
| POST `/api/agent/heartbeat`, `/traffic`, `/bootstrap-status` | N | own node row | — | — | — | — | self-reported load (F-24) |
| POST `/api/agent/leases/sync` | N | own node slots | — | — | generation monotonic | — | valid_until ≤ 2 h |
| POST `/api/agent/probe-credential`, GET `/probe-targets` | N + lifecycle | own / chosen peers | — | — | — | — | peers' probe creds exposed |
| GET `/api/agent/revision/:n` | N | own node | — | — | read | — | |
| POST `/api/agent/metrics` | N | own node's vpn users | — | — | — | — | no caller in singbox-vpn (dead) |
| POST `/api/internal/fleet-tick` | S | — | — | — | leases per op | — | |

### 5.3 BOLA / IDOR tests

I traced every customer route that takes an id (`devices/:id`, `subscriptions/:id`, `connection-profiles/:id`,
`invites/:id`, `members/:id`, `/v1/devices/:id`, `/v1/subscriptions/:id`, Telegram equivalents, `vpn/config?deviceId=`).
All of them compare the object's `account_id` with the caller's account before acting (`deviceOrFail`,
`getAccountSubscription(... .eq("account_id"))`, `ownProfile`, device/profile checks in `assignDeviceProfile`,
DB triggers `enforce_device_profile_assignment_account` and `enforce_device_subscription_account`).
**User A cannot read or change User B's device, subscription or profile.** Result: no cross-account IDOR found.

What is missing is a **role** check inside an account (legacy "member" rows) — see F-12.
Agent routes are correctly scoped by node id. Admin routes have no per-object limits by design.

### 5.4 Session handling

- Tokens live in `localStorage` for both customers and admins, on the same origin as the public marketing
  site. CSP has no `script-src`. Any XSS anywhere on the origin gives full account and admin takeover (F-15).
  I found no XSS sink in `src/` (no `dangerouslySetInnerHTML`, no `innerHTML`, no user-controlled `href`).
- CSRF: not applicable — every state change needs a Bearer header, not a cookie.
- CORS: Functions set no CORS headers, so cross-origin reads are blocked. Static pages get
  `access-control-allow-origin: *` from Cloudflare (harmless for static HTML).
- Open redirect after login/signup via control characters in `?next=` (F-14, verified in Chromium).
- Password change does not end other sessions; `/v1/auth/logout` ends only the current one (F-22).

---

## 6. Database / RLS

### 6.1 Method

I created a fresh PostgreSQL 16 database with the same roles and default privileges hosted Supabase uses
(`anon`, `authenticated`, `service_role` with `bypassrls`, `ALTER DEFAULT PRIVILEGES … GRANT ALL … TO anon,
authenticated, service_role`), a minimal `auth.users` and `auth.uid()`, then applied all 37 migrations in order.
This is the closest local equivalent to "what a fresh Supabase project gets".

### 6.2 Schema map (37 tables, all in `public`)

- **Identity/billing**: `profiles`, `customer_accounts`, `account_members` (legacy roles), `member_invites`
  (legacy), `subscriptions` (Stripe mirror, many per account), `admin_entitlements`, `stripe_events`.
- **Devices/credentials**: `devices` (per account, `subscription_id`, `auth_session_id`), `vpn_accounts`
  (identity per device per node), `vpn_secrets` (AES-GCM URLs, append-only), `provisioning_jobs`,
  `device_profile_assignments`, `connection_profiles`, `device_node_assignments`.
- **Managed auth (ADR-0003)**: `node_lease_slots`, `vpn_leases`, `node_lease_policy`, `node_transport_secrets`.
- **Fleet**: `nodes`, `locations`, `allowed_paths`, `fleet_operations`, `operation_steps`, `node_revisions`,
  `node_probe_results`, `node_probe_credentials`, `route_directory_state`.
- **Telemetry/ops**: `node_traffic_samples`, `node_traffic_daily`, `vpn_usage_current`, `vpn_usage_hourly`,
  `operational_alerts`, `abuse_signals`, `admin_users`, `admin_audit_log`.
- **Telegram**: `telegram_links`, `telegram_link_codes`.

### 6.3 Results (verified on the replayed schema)

- **RLS is enabled on all 37 tables.**
- `anon`/`authenticated` hold **no privileges** on 33 tables. They hold `SELECT` on `profiles`,
  `subscriptions`, `vpn_accounts`, `devices`, `connection_profiles`, `device_profile_assignments`,
  `locations`, `telegram_links`, each with an own-row/own-account policy.
- **`node_probe_credentials` and `node_probe_results` were never revoked**: `anon` and `authenticated` hold
  `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER`. RLS blocks row access (verified: anon
  select returns 0 rows, insert fails RLS), but **`TRUNCATE` is not covered by RLS and succeeded as `anon`**
  at SQL level. PostgREST does not expose TRUNCATE, so this is not reachable through the Data API today.
  Defense-in-depth gap (F-33).
- The policies on `subscriptions`, `devices`, `connection_profiles`, `device_profile_assignments` use a
  sub-select on `account_members`, which `authenticated` cannot read. A direct PostgREST read by a customer
  **fails with `permission denied for table account_members`**. This fails closed (safe) but means these
  policies are dead code; nothing in `src/` reads these tables directly.
- **None of the 24 SECURITY DEFINER functions is executable by `anon`/`authenticated`.** 20 use
  `search_path = ''`. Four use `search_path = public` (`lease_fleet_operations`, `prune_node_probe_results`,
  `register_node_create_operation`, `register_node_replace_operation`) — acceptable because only
  `service_role` can call them, but should be `''` (F-33).
- Constraints worth noting: `provisioning_jobs.idempotency_key NOT NULL UNIQUE`; one in-flight `CREATE_USER`
  per (device, node); `vpn_accounts (device_id, node_id)` unique; `devices.auth_session_id` unique;
  `telegram_links.telegram_user_id` unique; `account_members.user_id` unique; one pending
  `APPLY_NODE_REVISION` per node.
- Cascades: deleting the auth user cascades profiles, members, devices (via account), telegram rows.
  `admin_audit_log.admin_user_id` has no ON DELETE → an admin's auth user cannot be deleted while audit rows
  exist (acceptable; keeps the trail).
- **No service-role key in client bundles.** Searched `out/` and the production bundle: only the public
  anon key and project URL are present. The production anon key is an **HS256** legacy key.

### 6.4 Browser → Supabase bypass

The catastrophic class ("browser talks to Supabase directly and reads another account") is **not present**:
there are no write grants to `anon`/`authenticated`, and read policies are own-row or fail closed. I could not
confirm this on the hosted project (section 22).

---

## 7. Billing (Stripe)

Model in code: base price `STRIPE_PRICE_ID` = 3 devices; pack price `STRIPE_SEAT_PRICE_ID` × quantity =
+3 devices each; `MAX_EXTRA_PACKS = 17`; many subscriptions per account; UI prices are hard-coded constants
(699 cents), not read from Stripe.

What works: signature verification on the raw body, event-id dedupe with a retry-safe `processed_at`,
provisioning keyed by deterministic idempotency keys, `invoice.paid` as the provisioning trigger, trial
reservation with a row lock, `canceled` treated as terminal for `invoice.paid`, capacity counted in devices
(not seats) everywhere in the live paths.

Scenario results:

| Scenario | Result |
|---|---|
| New subscription | checkout → `checkout.session.completed` inserts `incomplete` → `invoice.paid` activates and enqueues `CREATE_USER`. OK. |
| Add pack (+1) | Stripe update with prorations, mirror to `extra_seats`, reconcile. **No confirmation in UI** (F-35), no Stripe idempotency key. |
| Remove pack (−1) | blocked below used devices. OK. |
| Multiple subscriptions | supported; legacy `/api/cancel-subscription` and `/resume-subscription` return 500 when an account has ≥2 live subs. |
| Move device | capacity check not atomic (two moves can overfill); entitlement is still ranked per subscription, so overfill is not served. |
| Revoke device | status CAS + lease revocation + DISABLE jobs. OK. |
| Cancel / resume | Stripe `cancel_at_period_end` + mirror. OK. |
| past_due | treated as live forever; depends on Stripe dunning settings (F-40). Node expiry does not follow (F-19). |
| Payment failure / unpaid | `subscription.updated(unpaid)` disables. OK. |
| Free trial | one per account; unlimited accounts per card (F-41). |
| Duplicate webhook | deduped. OK. |
| **Out-of-order webhook** | **Stale `subscription.updated` after `deleted` sets status back to `active` and overwrites `extra_seats`** (F-02, reproduced). |
| Webhook delayed hours | renewal expiry gap (F-19). |
| Checkout abandoned | no row created; trial reservation expires after 24 h. OK. |
| Billing portal changes | pack quantity mirrored; **base price/plan never validated** (F-31). |
| Subscription deleted in Stripe | disables devices. OK. |
| Price mismatch / unknown item | ignored; any subscription-mode checkout on the Stripe account provisions VPN (F-31). |
| Concurrent pack update | last write wins in Stripe; mirror follows the webhook. Acceptable. |
| Concurrent device registration | entitlement ranking prevents over-serving **except** through profile assignment (F-01). |
| Account deletion | not atomic (F-08). |

Legacy "seat/member/invite" paths: `invites` and `seats` return 410; `accept-invite`, `members/:id`,
`invites/:id` still run but all invites were revoked by migration `20260926000000`. The dangerous legacy path
is not these endpoints but the **missing owner checks** in the shared account service (F-12).

---

## 8. Managed VPN API (ADR-0002/0003, tamara-next)

- `/v1` shapes match tamara-next's client (`dart_io_managed_control_plane_client.dart`): every `/v1` route file
  in vpn-web (15) is called by the client with the same method and field names (`extra_packs`, `subscription_id`, `checkout_url`, `route_id`,
  `client_request_id`, `credential_envelope`).
- **Signed directory**: Ed25519 over canonical JSON, `key_id`, 1 h TTL, monotonic version bumped only when
  content changes. The client supports a key set (`TAMARA_ROUTE_SIGNING_KEYS`), the server signs with one key.
  Version bump is read-then-write without compare-and-swap (F-45).
- **Route binding**: route ids are content-derived hashes of mode, locations, node ids and every public hop
  field. `authorize` rebuilds candidates and returns `409 route_stale` on any change. No unsigned downgrade path
  in vpn-web. Relay and exit are distinct machines by construction (different roles).
- **Entitlement**: `/v1/vpn/authorize` uses **per-device** entitlement — correct. `lease_route_slots` re-checks
  device status under a per-device advisory lock; revocation takes the same lock. I verified the RPC with the
  repo's own SQL test (after fixing its stale insert).
- **Credential expiry**: node-enforced `valid_until` (≤ 2 h, ≥ 10 min remaining), renewal extends in place.
- **Empty directory**: returns `routes: []` (tamara-next accepts it after PR #25).
- **Wrong-account / wrong-device**: leases are keyed to the device from the caller's own session; idempotency
  key includes device and route; reuse for another route → 409. OK.
- Weak points: pool exhaustion by one account (F-11); the directory is served to any free account (F-26).
- The legacy `/api/vpn/config` path (subscription URLs for Hiddify etc.) is the weak side of the design: gated by
  account-level entitlement (F-01), long-lived URLs, and hostnames that outlive nodes (F-06).

---

## 9. Fleet scheduling / node assignment

- AUTO / DIRECT / DOUBLE_HOP placement (`scheduler.js`) filters READY/CANARY nodes of the right role and
  location, honours `allowed_paths` (missing row = not allowed), fails closed, and never writes a partial
  double-hop.
- Legacy mode (flag off) puts every device on `node-1`.
- Capacity is `configured_users < max_sessions`, where `configured_users` is **self-reported every 60 s and
  counts lease-pool slots and disabled users** (F-23). No reservation: a burst of placements within a minute all
  go to the same least-loaded node (F-25). A device's sticky node is dropped as soon as that node is "full",
  even though the device is part of the count (the route directory handles this with `heldNodeIds`; the
  scheduler does not).
- Tested cases by reading: no nodes → null (fail closed); one node → it; all full → null; degraded/offline →
  excluded; stale heartbeat → node still eligible until silence detection runs (lazy, F-20); entry available but
  exit unavailable → null, nothing written; same node twice → impossible (different roles); concurrent
  assignment → last upsert wins, capacity overshoot possible.

---

## 10. Fleet health / auto-failover

What exists in code: READY↔DEGRADED hysteresis (3 fail / 5 pass), silence → FAILED (3 missed heartbeats),
FAILED→READY only for `failed_reason = SILENCE`, protocol probes with peer quorum, CANARY with 2 h
observation, REPLACE_NODE saga (create → canary → drain → retire), auto-replace after
`AUTO_REPLACE_AFTER_FAILED_MS` (disabled when unset or ≤ 0), auto-scale per (location, role).

What does **not** exist, or only exists on paper:

- **Silence detection is lazy.** It runs only when another node heartbeats (with `FEATURE_AUTO_NODE_HEALTH`) or
  an admin opens the node list. `fleet-tick` does not run it. With one node, or when all agents are down,
  nothing ever marks a node FAILED, so auto-replace never starts (F-20).
- **No device failover.** Nothing re-places devices away from a FAILED or DRAINING node. Devices move only when
  something else triggers a reconcile (device change, monthly `invoice.paid`). The managed app fails over on its
  own (client picks another signed route); legacy subscription-URL users do not (F-20).
- **Drain is passive and then forced.** `DRAIN_OLD_NODE` waits for `device_node_assignments` to empty, which
  rarely happens without a reconcile, so it usually hits `maxWaitHours` (default 72 h) and then
  `RETIRE_OLD_NODE` destroys the server while legacy devices still point at it (F-20). DNS is not removed (F-06).
- **Flapping**: FAILED→READY needs one heartbeat; no cooldown. Auto-replace timer resets on each flap, which
  limits damage. One bad probe cannot destroy healthy capacity: probes never cause FAILED; only silence does,
  and auto-replace requires FAILED for the configured time. A control-plane outage longer than 3 minutes marks
  many nodes FAILED at once when the first heartbeat returns; they recover on their own next heartbeat, so this
  only matters if `AUTO_REPLACE_AFTER_FAILED_MS` is set very low.
- **Auto-scale has no global cap**, and with F-23 every node with `max_sessions ≤ pool size` looks full, which
  can create nodes every time the previous one becomes READY (cost runaway) (F-23).
- **Duplicate cron / concurrent ticks**: operations are leased (`SKIP LOCKED`), auto-replace/scale are protected
  by unique keys/ids. Safe. Lease is 120 s and provider calls have no timeout; a slow Hetzner create can overlap
  the next tick and create a second server (low probability) (F-47).
- **Revision rollout** is broken: `createNodeRevision` inserts a job without `idempotency_key` (NOT NULL) and
  always fails after writing the revision row (F-17, verified in Postgres).
- **Real-infra evidence**: `docs/FLEET_LIFECYCLE_AUTOMATION.md`, `NODE_BOOTSTRAP.md` and
  `FLEET_RESILIENCE_DRILLS.md` all say *not yet verified / not yet run*. I agree with those labels.

---

## 11. Provisioning agent trust

A node authenticates with a random 256-bit key generated on the VPS (only its hash is sent). Good.

What one compromised node **cannot** do (verified by reading every agent route): read or complete another
node's jobs, fetch another node's revision, sync another node's lease slots, write usage for another node's
users, get customer emails or Stripe data, change customer state beyond its own jobs.

What it **can** do:

- Keep working after quarantine/retire — no revocation (F-05).
- Report low `configured_users` and healthy probes to attract more devices and routes (F-24).
- Complete `CREATE_USER` with an arbitrary `subscription_url` / `provisioning_url` pointing anywhere; these are
  shown to the customer as-is (F-24).
- Obtain up to 3 peers' `arcana-probe` credentials per hour (egress through those peers) (F-24).
- Change its advertised transport fields any time through `bootstrap-status` (affects only its own routes).
- Read job payloads with `user_id`, `device_id`, `expires_at` for its own jobs (pseudonymous, acceptable).

No request signing or replay protection beyond TLS; no per-node rate limit. Acceptable for now if F-05 is fixed.

---

## 12. Node bootstrap / provider integration

Good: token minted just before `createInstance`, hash stored first, adoption by label after lost responses,
key generated on the node, token deleted after enrollment, no secrets in argv/logs, DNS unproxied with TTL 60.

Partial-failure handling:

| Failure | What happens |
|---|---|
| VPS created, DNS failed | step retries (8 attempts, backoff), then op FAILED, node FAILED, **server kept** (cost) |
| DNS created, install failed | bootstrap unit retries forever; op fails at 90 min deadline; server + DNS kept |
| Install ok, enrollment failed | node FAILED at deadline; server + DNS kept |
| Readiness never passes | same |
| Provider API timeout | no timeout on `fetch`; lease may expire mid-call; possible duplicate server (F-47) |
| Retire | server destroyed; **DNS record never deleted** (F-06) |
| Failed REPLACE_NODE | idempotency key `REPLACE_NODE:<old>` is permanent; the node can never be replaced again without a manual DB edit (F-48) |

Supply chain: `install.sh` is fetched from `raw.githubusercontent.com` by **tag** and run as root. The
installer verifies release artifacts, but the installer itself is not pinned by commit or hash (F-37).

No cleanup job exists for FAILED nodes' servers and DNS records ("kept for inspection").

---

## 13. Admin security

- Strong gate: JWT + `admin_users` + `aal2`. Read-only role enforced on every write route I read.
- Every admin mutation writes `admin_audit_log`, **after** the mutation, best effort (a failed audit insert is
  only logged). The table is writable by `service_role` like any other; no hash chain or append-only guard.
- No server-side confirmation token or rate limit for destructive actions; the UI uses a typed confirm for node
  lifecycle and `window.confirm/prompt` elsewhere.
- Several admin JSON responses lack `Cache-Control: no-store` (e.g. `customers/:id`).
- Admin UI and API live on the same origin as the public site and share the customer session storage (F-15).
- `disable`/`enable`/`rotate` act on a single legacy identity per user and break for real customers (F-07).
- Abuse page: `abuse_signals` has **no writer** anywhere (vpn-web or singbox-vpn), so it is always empty; its
  "Disable" button calls the broken disable route.

---

## 14. Telegram

- initData HMAC per Telegram's spec, constant-time compare, `auth_date` freshness (24 h reads, 1 h writes,
  60 s future skew). Forged user ids are rejected without the bot token.
- Link codes: 8 chars from a 32-char alphabet (40 bits, unbiased), 10 min TTL, hash-only storage, single use
  with CAS. Brute force is not practical, but there is no rate limit (F-49).
- One Telegram id ↔ one account (unique index). Unlink needs recent web auth or fresh initData.
- Account takeover via Telegram: a stolen Telegram account gets Mini App access to devices and profiles of the
  linked Arcana account (no billing, no setup URLs). This is by design; document it.
- The Mini App's assignment route shares the capacity bypass (F-01).

---

## 15. Privacy / GDPR

| Data | Where | Why | Retention | Access | Deleted on account deletion? |
|---|---|---|---|---|---|
| Email | `auth.users`, `profiles` | login | account life | service role, admins | yes (auth delete cascades) |
| Password hash | GoTrue | login | account life | GoTrue | yes |
| Stripe customer/subscription ids | `customer_accounts`, `subscriptions` | billing | forever while account exists | admins | yes (cascade); **Stripe customer object is never deleted** |
| Full Stripe event payloads (names, emails, addresses, amounts) | `stripe_events.payload` | idempotency/audit | **forever** | service role | **no** (no FK) |
| Telegram id + username | `telegram_links` | Mini App | until unlink | admins via DB | yes |
| Device name, platform, last seen, revoked devices | `devices` | product | **forever** (revoked kept) | admins | yes |
| Connection records (device → route → time) | `vpn_leases` | managed auth | **forever** | service role | yes (device cascade) |
| Node assignment history | `device_node_assignments` | scheduling | current only | admins | yes |
| Plain-text subscription/provisioning URLs | `provisioning_jobs.result` | none (side effect) | **forever** while the identity exists | admins (provisioning URL unredacted) | yes, through `vpn_accounts` cascade; but they are in every backup taken before that |
| Encrypted URL history | `vpn_secrets` | delivery | forever (append-only) | service role | yes (cascade) |
| Node traffic totals | `node_traffic_samples` (every 15 s per node) | ops | **forever** | admins | n/a (per node) |
| Per-user traffic tables | `vpn_usage_*` | legacy | no producer | — | yes |
| Admin audit log (user ids, grant reasons) | `admin_audit_log` | audit | forever | admins | no |
| Job-failure emails with user id + agent error text | Resend → **hard-coded personal iCloud address** | alerting | outside our control | one person | no |

Good: sing-box runs with log level `fatal` and no output (singbox-vpn `crates/compat-config/src/server.rs`),
the agent reports node totals only, no destination/domain/DNS data is stored, and ADR-0003 lease slots are
pseudonymous.

Problems: the privacy page is a draft with TODOs, claims an abuse-IP-count mechanism that does not exist,
omits Telegram, device metadata, connection records, Hetzner and Telegram as processors, and says the config
URL is "stored encrypted" while plain-text copies sit in `provisioning_jobs` (F-18, F-04).

---

## 16. Performance

### 16.1 Frontend (measured)

Static build served locally (no compression), Chromium, mobile emulation 390×844, Slow-4G-like network
(150 ms RTT, 1.6 Mbps) and 4× CPU throttle:

| Page | FCP | LCP | CLS | JS decoded |
|---|---|---|---|---|
| `/` | 1640 ms | 1640 ms | 0.011 | 628 KB |
| `/pricing/` | 1580 ms | 1580 ms | 0 | 628 KB |
| `/login/` | 1572 ms | 1572 ms | 0 | 633 KB |
| `/account/` | 1580 ms | 1580 ms | 0 | 643 KB |
| `/telegram/` | 1540 ms | **3904 ms** | 0 | 632 KB |
| `/` desktop, no throttling | 72 ms | 72 ms | 0.010 | 628 KB |

Build report: home First Load JS 172 kB gzip; the Supabase client (~65 kB gzip chunk) is loaded on every
public page because `Nav`/`HeroActions` read the session. Only one small CSS file (48 KB raw). No web fonts.

Goals I recommend (concrete, achievable for this simple site):
- Public pages (/, /pricing, /locations, legal): **≤ 100 kB gzip JS**, no Supabase SDK (read the
  `arcana-auth-v1` localStorage key directly for the "Log in / Account" link, load the SDK only on auth pages).
- Mobile Slow-4G LCP **≤ 1.2 s** on `/`, **≤ 2.0 s** on `/telegram/`; CLS < 0.02.

### 16.2 Backend / DB (by reading; I could not measure the live API)

- **HS256 project key**: the public anon key is HS256 (verified). If user access tokens are HS256 too (likely,
  not verified — section 22 check 1), `getClaims()` calls GoTrue `getUser()` on every authenticated request —
  one extra network round trip per call. Moving to asymmetric JWT signing keys
  (as `PRODUCTION_SCALING.md` recommends) removes it (F-43).
- **Reconcile is N+1**: `reconcileAccountProvisioning` runs 3–8 sequential queries per device and is triggered
  by every app login (new device), device change, profile change, pack change and renewal. At the 60-device cap
  that is hundreds of sequential queries in one request.
- `/v1/routes`: 4 queries + an optional write + signing per request, no caching; fine for hundreds of users,
  a waste at thousands (cache the signed envelope per version for 30–60 s).
- `authorize` enumerates every relay×exit pair (`exhaustive`), fine at current fleet size.
- Heartbeat: each node's heartbeat scans all nodes for silence → O(N²) queries per minute.
- `node_traffic_samples` grows ~5,760 rows/day/node with no pruning.
- PostgREST's default `max_rows = 1000` silently truncates unbounded selects (admin assignment/health
  aggregates over `device_node_assignments`) once there are more than 1000 rows (F-50).
- At 1k users / 10k users / 100k devices: indexes exist for the hot lookups (`devices.account_id`,
  `vpn_accounts.device_id`, `subscriptions.account_id`, `provisioning_jobs (node_id,status,created_at)`,
  `vpn_leases (device_id|account_id, created_at)`). The scaling cliffs are the N+1 reconcile, unpruned tables,
  truncated admin aggregates and the per-request GoTrue round trip — not missing indexes.
- `scripts/load-control-plane.mjs` exists but was not run (needs a real token); not run against production.

---

## 17. Reliability / distributed failure modes

| Failure | Behaviour |
|---|---|
| Stripe down | checkout/portal/packs return 502/500; webhooks retried by Stripe. No outbound timeouts. |
| Supabase down | every Function 500; agents keep enforcing expiry locally; leases expire on nodes. OK. |
| Function timeout mid-reconcile | jobs enqueued so far stay; keys with `Date.now()` mean the retry enqueues a new set (duplicates are harmless but noisy). |
| Provider API down | fleet op retries 8× with backoff, then FAILED; server/DNS may leak. |
| Telegram down | only the Mini App. |
| Agent down | jobs stay pending; claimed ones stay claimed **forever** (F-09); silence not detected without another node (F-20). |
| Network split node↔control plane | node keeps serving; leases end at `valid_until`; legacy users keep working until expiry. |
| Duplicate fleet tick | safe (leases, unique keys). |
| Webhook delayed hours | renewal gap for legacy users (F-19); stale events can resurrect state (F-02). |
| Out-of-order events | F-02. |
| Operations that can run twice dangerously | account deletion (partial), Stripe pack update without idempotency key (double charge unlikely: absolute quantity), `setExtraPacks` race is last-write-wins. |

Silent failures: failed audit writes, failed Stripe mirror writes (`setExtraPacks`, cancel), failed webhook
handlers (console only), stuck jobs, stopped fleet tick, failed DNS/provider cleanup, lost alerts when Resend is
misconfigured (F-36).

---

## 18. Migrations

- Replay from empty: clean (verified).
- Safety: all changes are additive or small backfills; no long table rewrites at current scale. Backfill loops
  (`fleet_foundations`, `device_identities`) are row-by-row — fine for hundreds, slow for 100k rows.
- No down migrations; rollback = restore.
- Old code / new DB: fine (additive). **New code / old DB is not safe**: Functions deploy with Pages; if they go
  out before migrations (e.g. `node_probe_*`, lease tables), routes 500. There is no runtime schema-version check.
- `route_directory_state` had no RLS between `20260928000000` and `20260930010000`. Any environment migrated in
  that window had it exposed to `anon` writes through PostgREST until the fix migration ran. Whether production
  ran the fix is **not verified** (section 22).
- The SQL test files are stale and not in CI (F-32).

---

## 19. Backup / disaster recovery

- `docs/FLEET_RESILIENCE_DRILLS.md` says the backup/restore drill is **not yet run**. A backup never restored is
  not verified.
- Stripe is the billing source of truth; the local mirror can be rebuilt from Stripe, but there is no script.
- Fleet state recovery: nodes can re-enroll (FAILED→PROVISIONING issues a new token); lease pool recovers from the
  agent's local table.
- **`VPN_SECRETS_ENCRYPTION_KEY`** is a single key with no key id or rotation path. Losing it makes every stored
  subscription URL, lease secret and obfs password unreadable. Leaking it plus a DB backup exposes all of them.
- **Route-signing key**: single key id; clients already support a key set, the server does not. No documented
  escrow or rotation.
- Audit log recovery: only via DB backup.
(F-34)

---

## 20. Observability

- Logs: `console.error` strings, not structured; no request ids; no metrics.
- Alerts: rows in `operational_alerts` (node disk/memory/degraded/failed, job failed) plus one email per failed
  job to a hard-coded personal address. Nothing pages anyone.
- Missing signals: fleet tick stopped, webhook failure rate, stuck `claimed` jobs, pending-job age, reconcile
  errors, Stripe mirror write failures, deletion finalization failures, DNS/provider cleanup failures, auth
  failure spikes, lease pool exhaustion, route directory empty.
- Log privacy: I found no logging of tokens, passwords, subscription URLs or secrets in Functions. User ids and
  node ids are logged. Agent error text is emailed verbatim.
(F-36)

---

## 21. Frontend / UI safety

- No XSS sinks found. React escapes all data. `window.location.href = data.url` only for Stripe URLs returned
  by our API.
- **Open redirect** after login/signup (F-14, verified).
- **"Add 3 devices"** charges immediately on one click, with no confirmation dialog and no price next to the
  button (F-35). Cancel has a confirmation. Resume and remove-pack do not (acceptable).
- Double submit: buttons disable while busy. Good.
- Admin uses `window.confirm/prompt` for grants and abuse disable.
- Mobile account nav, 1/2-server configuration and subscription pages render without overflow at 360–1440 px
  (a11y script, 0 findings).
- Copy uses "device"/"subscription" consistently; "seat/member/invite" remain only in the legacy invite page,
  admin customer detail and hooks.

---

## 22. Production verification

What I verified against production (read-only, public URLs only):

| Check | Result |
|---|---|
| `https://arcana-web-epw.pages.dev/` headers | CSP `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` (no `script-src`), XFO DENY, nosniff, Referrer-Policy, Permissions-Policy. No HSTS header (the `.dev` TLD is HSTS-preloaded, so browsers enforce HTTPS anyway; a custom domain will need HSTS). |
| Deployed build vs `main` | **Different.** Production homepage chunk `app/page-fabc52…` has the old hero markup and the locations list; `main` builds `app/page-51ee84…` with `hero__frame/strip`. Production frontend is older than `main`. |
| Deployed API routes | Present: `/v1/routes`, `/v1/vpn/authorize`, `/api/agent/leases/sync`, `/api/agent/probe-credential`, `/api/agent/probe-targets`, `/api/internal/fleet-tick`, admin fleet routes. All reject unauthenticated calls correctly (401/410). |
| `GET /api/locations` | `{"locations":[]}` — no enabled location with a READY node. |
| Legal pages | `/terms/` and `/privacy/` contain "TODO (legal review needed): this page is a structural draft"; `/impressum/` contains `[Company or sole-proprietor legal name]`. |
| `/admin/` | publicly served (static shell; API protected). |
| Bundle secrets | only the Supabase project URL and the **anon** key (HS256). No service-role key. |

What I tried and was **blocked** from doing (this session's safety classifier refused read-only GETs to the
production Supabase REST/Auth endpoints with the public anon key). Please run these yourself (all read-only):

```bash
# 1. JWT signing keys (empty list => legacy HS256 => extra GoTrue round trip per request)
curl -s https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
# 2. Auth settings (signup, autoconfirm, providers)
curl -s -H "apikey: <anon key>" https://<project-ref>.supabase.co/auth/v1/settings
```

```sql
-- 3. Migration state vs the 37 files in supabase/migrations
select version from supabase_migrations.schema_migrations order by version;
-- 4. Any table without RLS, and any anon/authenticated write grant
select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT';
-- 5. Legacy members who can use F-12
select count(*) from account_members where role = 'member';
-- 6. Plain-text URLs sitting in job results (F-04)
select count(*) from provisioning_jobs where result ? 'subscription_url' or result ? 'provisioning_url';
-- 7. Stuck jobs (F-09)
select count(*), min(claimed_at) from provisioning_jobs where status = 'claimed' and claimed_at < now() - interval '15 minutes';
-- 8. Devices that could use F-01
select count(*) from devices where status = 'ACTIVE' and subscription_id is null;
-- 9. Retired nodes whose DNS may still exist (F-06)
select node_id, hostname, retired_at from nodes where lifecycle_state in ('RETIRED','FAILED') and hostname is not null;
-- 10. Was the route_directory_state fix applied?
select relrowsecurity from pg_class where oid = 'public.route_directory_state'::regclass;
```

Not checked (no credentials): Stripe live/test mode, products and prices, portal configuration, dunning
settings, webhook endpoint event list; Cloudflare Pages env vars (`ARCANA_PRODUCTION_DEPLOY`, feature flags);
Hetzner and Cloudflare DNS state; Telegram bot settings; backups.

---

## 23. Findings

Severity: **P0** = do not take real payments until fixed. **P1** = fix before launch / first paying customers.
**P2** = fix soon after. **P3** = hygiene.
Difficulty: S (≤ 1 day), M (a few days), L (a week or more).

### F-01 — Device capacity bypass through profile assignment (P0)
- **Evidence**: `assignDeviceProfile` reconciles the device with the **account-level** entitlement
  (`functions/lib/device-assignment.js:102`, `getEffectiveEntitlement`), not the device's own entitlement. That
  enqueues `CREATE_USER` (or `ENABLE_USER`) for a device outside any subscription's capacity. `/api/vpn/config`
  gates on account-level entitlement too (`functions/api/vpn/config.js:39`) and returns that device's
  subscription URL. `finalizeCreatedIdentity` checks only revoked/membership. Extra device rows are free to
  create: every `/v1/auth/login` makes a new device (`ensureSessionDevice`, `account-service.js:284`) with
  `subscription_id = null` when full, and it has no 60-device cap.
- **File/API**: `POST /api/account/devices/:id/assignment`, `POST /api/telegram/devices/:id/assignment`,
  `GET /api/vpn/config?deviceId=`.
- **Reproduction**: test in Appendix A (`capacity bypass`): 3 devices on a 3-device subscription + a 4th with
  `subscription_id = null`; `loadDeviceEntitlements` says the 4th is not entitled; `assignDeviceProfile` returns
  200 and enqueues `CREATE_USER` for it. **Reproduced.**
- **Impact**: one €6.99 subscription → any number of working legacy VPN configs until the next account-wide
  reconcile (monthly renewal), and the user can simply re-assign again. Direct revenue loss and resale/sharing.
- **Fix**: in `assignDeviceProfile`, `vpn/config`, and `finalizeCreatedIdentity`, use
  `loadDeviceEntitlements(...).get(device.id)`; if null, never create/enable identities and return 403 from
  `vpn/config`. Add the device cap and a login/device-creation rate limit to `ensureSessionDevice`.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-02 — Out-of-order Stripe events overwrite newer state (P1)
- **Evidence**: `handleSubscriptionUpdated` writes `status`, `current_period_end`, `extra_seats` from the event
  object with no ordering check (`functions/lib/stripe-events.js:430-477`). `invoice.paid` sets `active`
  (only `canceled` blocks it).
- **Reproduction**: Appendix A test: `deleted` then a stale `updated(active, 2 packs)` → row ends `active`,
  `extra_seats = 6`. **Reproduced.**
- **Impact**: a cancelled subscription can come back as `active` in our DB forever (Stripe never sends another
  event for a deleted subscription) → free service; wrong device capacity.
- **Fix**: in every subscription handler, fetch the subscription from Stripe (`subscriptions.retrieve`) and write
  that state, or store `last_event_created` per subscription and ignore older events; never leave `canceled`.
- **Difficulty**: S–M. **Confidence**: 9/10. **Verified.**

### F-03 — Production legal gate not effective; live site shows draft legal pages (P0 for launch)
- **Evidence**: `scripts/check-production-config.mjs` only runs its checks when `ARCANA_PRODUCTION_DEPLOY=1`.
  Production `/terms/`, `/privacy/` are marked "structural draft"; `/impressum/` has placeholder entity/address.
  `SITE_URL`/`SUPPORT_EMAIL` fall back to `arcana.example`.
- **Impact**: selling a paid service in the EU/Germany without a valid Impressum, terms and privacy policy.
- **Fix**: finish legal text; make the gate fail closed on the production branch (e.g. run it when
  `CF_PAGES_BRANCH == main`, not on an opt-in flag); add a `/version` endpoint with the git SHA.
- **Difficulty**: S (code) + legal work. **Confidence**: 10/10. **Verified.**

### F-04 — Plain-text VPN setup URLs stored in `provisioning_jobs.result`; provisioning URL shown to admins (P1)
- **Evidence**: `complete.js:182` writes the agent's whole `result` to the job row. singbox-vpn
  `apps/provisioning-agent/src/dispatch.rs:193-209, 298-309` returns `subscription_url` and `provisioning_url`.
  `admin-sanitize.js:6` redacts only `subscription_url`, so `/api/admin/jobs` and `/api/admin/customers/:id`
  show `provisioning_url` to every admin, including read-only.
- **Impact**: DB access or any backup exposes working VPN credentials in plain text, making the
  `vpn_secrets` encryption pointless; over-exposure to admins.
- **Fix**: strip secret fields before writing `result`; redact every URL-like field in admin views; run a
  one-off `update provisioning_jobs set result = result - 'subscription_url' - 'provisioning_url'` (after
  approval).
- **Difficulty**: S. **Confidence**: 10/10. **Verified (cross-repo).**

### F-05 — Node credentials are never revoked (P1)
- **Evidence**: `authenticateNode` checks only `revoked_at` (`node-auth.js:30`); no code sets it. QUARANTINED
  and RETIRED transitions do not touch `api_key_hash`/`revoked_at`. Only probe routes check lifecycle.
- **Impact**: a quarantined (suspected compromised) or retired node keeps claiming jobs (with user/device ids),
  completing them, syncing leases, heartbeating.
- **Fix**: on QUARANTINED/RETIRED set `revoked_at = now()` and null `api_key_hash`; make `authenticateNode` also
  reject QUARANTINED/RETIRED; add an admin "revoke node key" action and a key-rotation path.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-06 — Dangling DNS after node retirement (subdomain takeover path) (P1)
- **Evidence**: `createCloudflareDns().deleteRecord` exists (`dns/cloudflare.js`) but no production code calls
  it; `RETIRE_OLD_NODE` destroys the Hetzner server (`fleet-operations.js:355+`) and leaves the A record.
  Legacy subscription URLs are `https://<subscription_host>:8443/sub/<token>` where `subscription_host` is the
  node hostname (singbox-vpn `apps/admin/src/main.rs:2380`).
- **Impact**: whoever later receives that Hetzner IP can get a valid certificate for the hostname and answer
  subscription refreshes from legacy clients (Hiddify auto-update) with their own outbound config → traffic
  interception. Also stale records for FAILED nodes.
- **Fix**: delete the DNS record in `RETIRE_OLD_NODE` (before destroying the server) and in a cleanup for
  FAILED/abandoned nodes; audit existing records now; re-place devices before retiring (F-20).
- **Difficulty**: S. **Confidence**: 8/10 (takeover requires getting the same IP). **Verified** (no caller);
  impact **Inferred**.

### F-07 — Admin "disable user" is broken for real customers and not durable (P1)
- **Evidence**: `disable.js`, `enable.js`, `rotate.js`, `rotate-credentials.js` and `customers/[id]/index.js`
  select `vpn_accounts` by `user_id` with `.maybeSingle()` (`disable.js:27`). With ≥2 identities (normal in the
  device model) PostgREST errors → 500. When it works it only enqueues `DISABLE_USER` for one identity, does not
  revoke the device, leases or the auth session, and the next reconcile (renewal, device change) enqueues
  `ENABLE_USER` again (`device-provisioning.js` "Only a disabled identity needs ENABLE_USER").
- **Reproduction**: Appendix A (`admin disable`) → 500. **Reproduced.**
- **Impact**: the abuse response does not work; the admin abuse page's "Disable" is dead.
- **Fix**: replace with an account-level "suspend" flag checked by entitlement resolution, revoke all devices
  urgently (`revokeDevice(..., {urgent:true})`), ban the auth user, audit it.
- **Difficulty**: M. **Confidence**: 10/10. **Verified.**

### F-08 — Account deletion is not atomic and can leave a banned user still billed (P1)
- **Evidence**: `requestAccountDeletion` (`account-service.js:347`) sets `deletion_requested_at`, bans the user,
  then cancels each Stripe subscription in a loop, then revokes devices. Any thrown error stops the loop. The
  user is already banned, so they cannot log in to retry or open the billing portal.
  `finalizeAccountDeletions` waits for all identities to be disabled, which never happens if the loop stopped.
- **Impact**: continued charges to a user who asked for deletion (consumer complaint, chargeback, GDPR).
- **Fix**: cancel Stripe subscriptions first (with idempotency keys), then revoke devices, then ban; make the
  fleet tick resume unfinished deletions (retry Stripe cancels, device revokes); alert when stuck. Decide on
  deleting the Stripe customer or documenting retention.
- **Difficulty**: M. **Confidence**: 9/10. **Verified** by code.

### F-09 — Claimed jobs are never re-queued (P1)
- **Evidence**: `claim_next_job` sets `claimed`; nothing ever moves a stale `claimed` job back to `pending` or to
  `failed` (searched all Functions). The partial unique index "one in-flight CREATE_USER per (device, node)"
  counts `claimed`, and `insertJob` treats 23505 as success.
- **Impact**: one agent crash between claim and complete stops that device's provisioning on that node forever,
  silently; account deletion finalization also waits forever on it.
- **Fix**: a reaper in fleet-tick: `claimed` older than N minutes → `pending` (agent side effects are idempotent
  per the singbox-vpn contract) with an attempt counter, then `failed` + alert.
- **Difficulty**: S. **Confidence**: 9/10. **Verified** by code.

### F-10 — Customer-triggerable node-wide disconnects (P1)
- **Evidence**: every per-user job applies through `vpn-admin` → `render_and_apply_singbox_config` →
  `systemctl reload-or-restart sing-box` (singbox-vpn `apps/admin/src/main.rs:3543`, `service.rs`); ADR-0003
  measured that a restart drops every open connection on the node. `POST /api/vpn/rotate-credentials` uses a
  random idempotency key per call (`rotate-credentials.js:38`), has no rate limit and is not used by the UI.
  Profile assignment and device add/remove also enqueue jobs with `Date.now()` keys.
- **Impact**: one customer can disconnect everyone on their node every few seconds.
- **Fix**: remove `/api/vpn/rotate-credentials` (or rate limit to a few per day); rate limit assignment/device
  changes per account; batch legacy user changes on the node like ADR-0003 does for leases.
- **Difficulty**: S (limits) / L (batching). **Confidence**: 9/10. **Verified (cross-repo)**; not run on a node.

### F-11 — One account can exhaust a node's lease pool (P2)
- **Evidence**: per-account limit 60 new leases / 10 min > default pool 32; revoked slots come back only after the
  node's next rotation batch. New app sessions create new, entitled devices after the previous one is removed.
- **Reproduction**: SQL simulation (Appendix B): 40 login→authorize→logout cycles for one account on a 32-slot
  node → 32 leases granted, attempt 33 `exhausted`, 0 slots left for anyone else. **Reproduced at DB level.**
- **Impact**: managed-app users on that node get `503 capacity_exhausted` for up to one batch window, repeatable.
- **Fix**: per-account limit ≤ a fraction of pool size; count *live* leases per account per node, not only new
  leases; rate limit logins/device creation.
- **Difficulty**: S. **Confidence**: 8/10. **Verified (DB)**.

### F-12 — Legacy "member" role not enforced in the shared account service (P1 if legacy members exist, else P3)
- **Evidence**: `setExtraPacks`, `setCancelAtPeriodEnd`, `renameSubscription`, `moveDevice`, `removeDevice`,
  `renameDevice` check only that the object is in the caller's account, never `role === 'owner'`
  (`account-service.js:122-277`). Used by web, `/v1` and Telegram routes. Legacy cancel/resume routes likewise.
- **Reproduction**: Appendix A (`legacy member`) → member sets 17 packs on the owner's subscription; Stripe update
  is called. **Reproduced.**
- **Impact**: a legacy member can charge the owner's card (up to +€118.83/month), cancel their subscriptions,
  remove or move their devices.
- **Fix**: require owner for billing and for other people's devices (same rule as `revoke.js`); or migrate legacy
  members out. Run query 5 in section 22 to size it.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-13 — No rate limiting on app auth proxies and other abuse-prone routes (P1)
- **Evidence**: `/v1/auth/login|register|refresh` forward to GoTrue from the Worker; GoTrue's per-IP limits then
  see Cloudflare egress IPs, not the client. No app-level limits on these, on `telegram/link`, `link-code`,
  device creation, profile changes, or the password check inside account deletion.
- **Impact**: either credential stuffing is effectively unthrottled, or one attacker trips the shared GoTrue
  limit and locks out all app logins. Unbounded device rows (F-01).
- **Fix**: Cloudflare WAF rate-limit rules per client IP on `/v1/auth/*` and `/api/telegram/link`; Turnstile on
  web signup/login; per-account limits in the DB for device creation.
- **Difficulty**: S–M. **Confidence**: 7/10. **Inferred** (depends on hosted GoTrue IP handling).

### F-14 — Open redirect after login/signup (P2)
- **Evidence**: `safeNextPath` (`src/lib/next-path.ts:24-25`) accepts `/\t/evil.test`; the URL parser strips
  tab/newline to `//evil.test`, and the Next router navigates off-origin.
- **Reproduction**: Chromium with mocked GoTrue, `/login/?next=%2F%09%2Fevil.test%2Fphish` → after login the
  browser is at `http://evil.test/phish/`. **Reproduced.**
- **Impact**: convincing phishing right after a real login ("session expired, enter your password again").
- **Fix**: resolve with `new URL(raw, location.origin)`, require same origin, and reject any control character.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-15 — Sessions in localStorage, no script-src CSP, admin on the public origin (P2)
- **Evidence**: `src/lib/supabase.ts` persists sessions in localStorage; `public/_headers` CSP lacks
  `script-src`/`connect-src`; admin pages and customer pages share the origin and storage key.
- **Impact**: any future XSS (dependency, markdown, third-party script) = customer and **aal2 admin** token theft.
- **Fix**: strict CSP (`script-src 'self'` + hashes for Next inline bootstraps, `connect-src` to Supabase and self);
  move admin to its own origin behind Cloudflare Access.
- **Difficulty**: M. **Confidence**: 8/10. **Verified** (config); no current XSS found.

### F-16 — Account-level entitlement used elsewhere where per-device is required (P2)
- **Evidence**: `/api/vpn/config` without `deviceId` returns the user's newest enabled identity if the *account*
  has any entitlement; `customer_dashboard_state` picks an arbitrary live subscription (`limit 1`, no order) for
  `current_period_end` and status.
- **Impact**: wrong status/expiry shown with several subscriptions; a device of a lapsed subscription keeps getting
  its config while another subscription is live.
- **Fix**: same as F-01; order deterministically.
- **Difficulty**: S. **Confidence**: 8/10. **Verified** by code.

### F-17 — Node revision rollout always fails against the real schema (P2)
- **Evidence**: `node-revisions.js:62` inserts `APPLY_NODE_REVISION` without `idempotency_key` (NOT NULL). Verified
  in Postgres: `null value in column "idempotency_key"`. The revision row and `desired_revision` are written first,
  so the admin gets 500 and the node state is half-updated. Unit tests mock Supabase and miss it.
- **Fix**: add a key (`apply-revision:<node>:<revision>`), write all three in one RPC.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-18 — Privacy retention and policy accuracy (P1)
- **Evidence**: no pruning for `vpn_leases`, `stripe_events` (full payloads), `provisioning_jobs`,
  `node_traffic_samples`, `telegram_link_codes`, revoked `devices`, `operational_alerts`; Stripe customer not
  deleted; privacy page is a draft, claims an abuse-IP mechanism that does not exist, omits several data types and
  processors (section 15).
- **Impact**: GDPR storage-limitation and transparency problems; larger breach impact.
- **Fix**: retention jobs in fleet-tick (e.g. leases 30 days, stripe_events 90 days with payload trimmed, samples
  → daily rollups after 7 days); finish the privacy policy from section 15's table.
- **Difficulty**: M. **Confidence**: 9/10. **Verified.**

### F-19 — Legacy clients lose service at every renewal and during dunning (P1)
- **Evidence**: node expiry is exactly `current_period_end` (`device-provisioning.js:191`); singbox-vpn treats a
  user as active only while `now < expires_at` with no grace (`compat-config/src/model.rs:291`). The new expiry is
  pushed only on `invoice.paid`; `customer.subscription.updated` does not push it. Stripe finalizes renewal invoices
  about an hour after the period starts, and `past_due` (DB says "live") never extends the node expiry.
  `getInvoiceLinePeriodEnd` reads `lines.data[0]`, which can be a proration line whose period ends at the *old*
  period end (`stripe-fields.js:104`).
- **Impact**: subscription-URL users drop at each renewal until `invoice.paid` is processed, and for the whole
  dunning window; a proration line first could set a wrong (past) expiry.
- **Fix**: node expiry = period end + grace (e.g. 3 days) and cut explicitly on `unpaid/canceled`; push expiry on
  `subscription.updated`; take the period from the subscription (retrieve it) or the max period end of
  subscription lines.
- **Difficulty**: S–M. **Confidence**: 7/10. **Inferred** (Stripe timing, line order); code **Verified**.

### F-20 — No real device failover; silence detection is lazy; drain is passive (P1)
- **Evidence**: see section 10. `failSilentNodes` is called only from `agent/heartbeat.js` and `admin/nodes.js`;
  nothing re-places devices off FAILED/DRAINING nodes; drain waits on `device_node_assignments` then forces.
- **Impact**: when a node dies, legacy users on it stay down until someone acts; with one node or all agents down,
  FAILED is never set; a replacement retires the old server under legacy users.
- **Fix**: run silence detection in fleet-tick; on FAILED/DRAINING, reconcile the node's devices
  (make-before-break); retire only when assignments are zero or after explicit re-placement.
- **Difficulty**: M. **Confidence**: 9/10. **Verified** by code.

### F-21 — Legacy/dead endpoints that are still live and risky (P2)
- **Evidence**: `/api/cancel-subscription`, `/api/resume-subscription` (no role check, break with ≥2 subs, unused
  by UI); `/api/vpn/rotate-credentials` (F-10, unused by UI); `/api/vpn/usage`, `/api/agent/metrics`,
  `vpn_usage_*` (no producer in singbox-vpn); `/api/account` (legacy seats/members payload); `/api/telegram/me`;
  `abuse_signals` (no writer); `UsageCard.tsx` (not imported); `/dashboard` redirect; `accept-invite`,
  `members/:id`, `invites/:id` (only needed if legacy members/invites exist).
- **Fix**: delete after confirming no caller in production logs (tamara-next does not call any of them).
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-22 — Session revocation gaps (P2)
- **Evidence**: `/api/account/password` uses `admin.updateUserById` without signing out other sessions;
  `/v1/auth/logout` is `scope=local`; with asymmetric keys `getClaims` would accept a banned/deleted user's access
  token until it expires (1 h). With the current HS256 project it calls `getUser()`, which checks the server.
- **Fix**: after password change call `signOut(scope: 'others')` via admin API; keep a server-side check for
  banned/deleted accounts on sensitive routes after moving to asymmetric keys.
- **Difficulty**: S. **Confidence**: 7/10. **Inferred** for hosted behaviour.

### F-23 — `configured_users` counts lease slots and disabled users; auto-scale has no cap (P2)
- **Evidence**: singbox-vpn `telemetry.rs` counts every row of `vpn-admin user list` except the probe user;
  `cmd_user_list` prints all users including `lease-NNNN` and disabled ones. vpn-web uses it for capacity,
  scheduling order and auto-scale (`isUnderCapacity`).
- **Impact**: nodes look full with 32 idle slots; auto-scale may add nodes in a loop (cost); scheduling is skewed.
- **Fix**: report customer users and lease slots separately; add a fleet-wide/location max for auto-scale.
- **Difficulty**: S. **Confidence**: 9/10. **Verified (cross-repo).**

### F-24 — Agent trust: self-reported load, unvalidated URLs, peer probe credentials (P2)
- **Evidence**: heartbeat sets `configured_users`/`probe_ok` from the agent; `complete.js` stores whatever URLs the
  agent returns; `probe-targets` returns peers' probe links.
- **Impact**: a compromised node can attract traffic, hand customers a config URL on another host, and use peers
  as egress.
- **Fix**: validate URL host == node hostname; cap how much one node's reported load can shift placement; rotate
  probe credentials and scope them (rate/traffic limits).
- **Difficulty**: M. **Confidence**: 8/10. **Verified** by code.

### F-25 — Scheduler capacity race and sticky loss (P2)
- **Evidence**: capacity from a 60-s-old self-report, no reservation; sticky node is dropped once "full".
- **Fix**: count assignments in the DB (`device_node_assignments` per node) under a lock or with an atomic counter;
  keep the device's own node when it is part of the count.
- **Difficulty**: M. **Confidence**: 8/10. **Verified** by code.

### F-26 — Node enumeration (P2, design)
- **Evidence**: `/v1/routes` needs only a free, confirmed account; it lists every READY node IP. Node hostnames are
  in public DNS and in Certificate Transparency logs (Let's Encrypt per node).
- **Impact**: a censor can list and block the fleet cheaply.
- **Fix**: require entitlement for `/v1/routes`; return only a subset per account; consider not issuing public
  certificates per node hostname.
- **Difficulty**: M. **Confidence**: 8/10. **Verified** by code.

### F-27 — `gotrue.js` falls back to the service-role key for public auth calls (P2)
- **Evidence**: `gotrue.js:22` `apikey: env.SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY`.
- **Fix**: require `SUPABASE_ANON_KEY`; fail closed.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-28 — Hard-coded personal alert recipient (P2)
- **Evidence**: `functions/lib/resend.js:60` sends every job failure (user id + raw agent error) to a personal
  iCloud address.
- **Fix**: `ALERT_TO_EMAIL` env var or a team inbox/on-call tool; drop user ids from email.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-29 — Production is not at `main`; no deploy provenance (P1)
- **Evidence**: section 22 (different homepage chunk and markup).
- **Fix**: deploy from CI with the SHA; expose `/version`; block Functions deploy if migrations are behind.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-30 — Unbounded device rows and N+1 reconcile per login (P2)
- **Evidence**: `ensureSessionDevice` has no cap and triggers `reconcileAccountProvisioning` for every new session.
- **Fix**: cap devices per account (also for sessions), reuse the device when the same app re-logs in (device key
  from the app), rate limit.
- **Difficulty**: S–M. **Confidence**: 9/10. **Verified.**

### F-31 — Stripe base price and products are not validated (P2)
- **Evidence**: `handleCheckoutSessionCompleted` accepts any subscription-mode session with a
  `client_reference_id`; nothing checks that the base item is `STRIPE_PRICE_ID`.
- **Impact**: any other subscription product on the same Stripe account, or a portal plan switch, provisions VPN.
- **Fix**: verify items on checkout completion and on `updated`; ignore/alert on unknown prices.
- **Difficulty**: S. **Confidence**: 8/10. **Verified** by code.

### F-32 — Tests do not exercise the real schema (P2)
- **Evidence**: `rls_test.sql` and `ephemeral_lease_pool_test.sql` fail on the current schema; CI never runs
  `supabase/tests`; `fake-supabase.js` does not enforce NOT NULL/FK/triggers, which hid F-17 and F-07.
- **Fix**: run `supabase/tests/*.sql` after `supabase db reset` in CI; add a small integration suite against local
  Postgres for job/route/lease paths.
- **Difficulty**: M. **Confidence**: 10/10. **Verified.**

### F-33 — Missing REVOKEs and `search_path = public` in SECURITY DEFINER functions (P3)
- **Evidence**: section 6.3 (anon TRUNCATE on `node_probe_credentials` succeeded at SQL level).
- **Fix**: `revoke all on node_probe_credentials, node_probe_results from anon, authenticated;`
  `revoke all on sequence node_probe_results_id_seq …`; set `search_path = ''` and schema-qualify.
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-34 — Backup/restore never tested; single unrotatable keys (P1)
- **Evidence**: section 19; resilience drills doc says "NOT YET RUN".
- **Fix**: run the restore drill; escrow `VPN_SECRETS_ENCRYPTION_KEY` and the route-signing key offline; add key
  ids to ciphertext; support two signing keys on the server.
- **Difficulty**: M. **Confidence**: 9/10. **Verified** (docs + code).

### F-35 — One-click paid pack purchase without confirmation (P2)
- **Evidence**: `src/app/account/subscriptions/page.tsx:111` "Add 3 devices" calls the paid API immediately.
- **Impact**: accidental charges; German "button solution" (§312j BGB) likely requires a clearly labelled
  payment button with the price.
- **Fix**: confirm dialog with the new monthly total and a "Buy for €6.99/month" style button.
- **Difficulty**: S. **Confidence**: 7/10 (legal part **Inferred**). **Verified** (UI).

### F-36 — Silent failures / no alerting (P1)
- **Evidence**: section 20.
- **Fix**: structured logs with request ids; alerts for fleet-tick staleness, webhook failures, stuck jobs,
  pending-job age, deletion backlog, empty route directory; page someone.
- **Difficulty**: M. **Confidence**: 9/10. **Verified.**

### F-37 — Bootstrap installer pinned by tag, not by content (P2)
- **Evidence**: `node-bootstrap.js` downloads `install.sh` from `raw.githubusercontent.com/<repo>/<tag>` and runs
  it as root.
- **Fix**: pin a commit SHA and check a SHA-256 of `install.sh` baked into the user data.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-38 — `/v1` billing and device actions do not need recent auth (P3)
- **Evidence**: `withV1User` uses `requireUser`; web equivalents use `requireRecentUser`.
- **Fix**: require recent auth (or a local app confirmation with re-auth) for packs/cancel/device removal.
- **Difficulty**: S. **Confidence**: 8/10. **Verified.**

### F-39 — Admin audit log is best effort and mutable (P2)
- **Evidence**: `writeAdminAudit` logs and ignores insert errors; table writable by service role; no audit for
  customer-side sensitive actions (account deletion, pack changes).
- **Fix**: write audit in the same transaction/RPC as the mutation; append-only trigger; ship to external storage.
- **Difficulty**: M. **Confidence**: 9/10. **Verified.**

### F-40 — `past_due` is live indefinitely (P3, config)
- **Evidence**: `LIVE_STATUSES` includes `past_due`; the outcome depends on the Stripe dunning setting
  (cancel/unpaid vs. leave past_due).
- **Fix**: confirm Stripe is set to cancel or mark unpaid after retries; optionally cap service in past_due.
- **Difficulty**: S. **Confidence**: 7/10. **Inferred.**

### F-41 — Trial farming (P3)
- One trial per account; accounts are free; no card fingerprint check. Use Stripe Radar rules or fingerprint dedupe.
- **Difficulty**: S. **Confidence**: 8/10. **Verified** by code.

### F-42 — Lint/install hygiene (P3)
- `next lint` skips `functions/`; `npm ci` needs `--legacy-peer-deps` (bump `@types/node` to ≥22).
- **Difficulty**: S. **Confidence**: 10/10. **Verified.**

### F-43 — Per-request GoTrue round trip (P2, performance)
- The project uses an HS256 key, so `getClaims` calls `getUser()` each request. Move to asymmetric signing keys.
- **Difficulty**: S (config). **Confidence**: 7/10. **Inferred** (user tokens assumed HS256 like the anon key).

### F-44 — Public pages ship the Supabase SDK (P3, performance)
- Section 16.1. Load the SDK only where auth is needed.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-45 — Route directory version bump is not compare-and-swap (P3)
- `route-signing.js` reads then updates `route_directory_state` without a version guard; concurrent different
  payloads can share a version. Use `update … where version = $old` or an RPC.
- **Difficulty**: S. **Confidence**: 8/10. **Verified.**

### F-46 — Checkout customer duplication / overwrite (P3)
- Two first checkouts create two Stripe customers; `checkout.session.completed` overwrites `stripe_customer_id`,
  so the portal shows only one. Create the customer before checkout.
- **Difficulty**: S. **Confidence**: 7/10. **Verified** by code.

### F-47 — No outbound timeouts (P3)
- Stripe, Hetzner, Cloudflare, GoTrue, Resend calls have no timeout; a slow create can outlive the 120 s op lease.
- **Difficulty**: S. **Confidence**: 8/10. **Verified.**

### F-48 — A failed replacement blocks future replacements of that node (P3)
- `REPLACE_NODE:<old>` idempotency key is permanent. Allow a new attempt when the previous op is FAILED.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-49 — Telegram link/link-code without rate limits (P3)
- Brute force is not practical (40 bits, 10 min), but add limits.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-50 — PostgREST `max_rows` truncation in admin aggregates (P3)
- Unbounded selects on `device_node_assignments` in admin fleet routes are silently cut at 1000 rows. Use SQL
  aggregates/RPCs.
- **Difficulty**: S. **Confidence**: 8/10. **Inferred** (hosted default 1000).

### F-51 — Hard-coded prices in UI/API (P3)
- `basePriceCents: 699`, `PACK_PRICE_CENTS` constants are not tied to Stripe prices; a Stripe price change would
  show wrong prices. Read prices from Stripe (cached) or assert at startup.
- **Difficulty**: S. **Confidence**: 9/10. **Verified.**

### F-52 — Tax configuration unknown (P2, business)
- Checkout does not enable `automatic_tax`; EU B2C digital services need VAT handling (OSS). Confirm with your
  accountant and Stripe Tax settings.
- **Difficulty**: S. **Confidence**: 6/10. **Inferred.**

---

## 24. Blockers

**P0 (do not take real payments):**
- F-01 device capacity bypass
- F-03 legal pages/gate on the live site

**P1 (fix before the first paying customers):**
F-02, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-12 (if legacy members exist), F-13, F-18, F-19, F-20,
F-29, F-34, F-36.

---

## 25. Remediation plan (order)

1. **Stop the money leaks**: F-01 (per-device entitlement everywhere + device cap), F-02 (retrieve from Stripe in
   webhooks), F-12 (owner checks), F-31 (validate prices).
2. **Legal/deploy**: F-03 (finish legal text, fail-closed gate), F-29 (`/version`, deploy from CI, migration check).
3. **Secrets and node trust**: F-04 (strip + purge plain-text URLs), F-05 (revoke keys on quarantine/retire),
   F-06 (delete DNS on retire + audit existing records), F-27.
4. **Account lifecycle**: F-08 (deletion order + resume), F-07 (real suspend), F-22.
5. **Reliability core**: F-09 (job reaper), F-19 (grace + expiry on update), F-20 (fleet-tick silence detection
   + re-placement before retire), F-17.
6. **Abuse limits**: F-10 (remove rotate route, rate limits), F-13 (WAF limits), F-11, F-30.
7. **Visibility and recovery**: F-36 (alerts), F-34 (restore drill, key escrow), F-39.
8. **Privacy**: F-18 (retention jobs, accurate privacy policy), F-28.
9. **Hardening**: F-14, F-15, F-24, F-25, F-23, F-26, F-37, F-33.
10. **Tests and hygiene**: F-32, F-42, F-21 (delete dead endpoints), F-43/F-44 performance, the P3 list.

Estimated effort to clear all P0+P1: roughly 2–3 focused weeks for one engineer, plus legal work and a staging
fleet for the drills.

---

## 26. Final readiness statement

The control plane is **not ready for paid production**. It is a solid prototype with thoughtful pieces (lease
pool, signed routes, strict RLS, Stripe signature handling), but a paying customer can currently exceed their
device capacity, stale Stripe events can restore cancelled service, node credentials cannot be revoked, retired
nodes leave DNS behind, stuck jobs never recover, account deletion can keep billing a locked-out user, and the
live site shows draft legal pages. None of the fleet automation has run against real infrastructure, and backups
have never been restored. Fix the P0 and P1 items in section 25's order, then re-verify production with the
queries in section 22 before accepting real payments.

---

## Appendix A — reproduction tests (scratch, not committed)

Run from the repo root with `npx vitest run <file>`; each test asserts the current (buggy) behaviour, so a pass
means "reproduced". All 4 passed on `6b3828e`.

```js
// capacity bypass (F-01) and webhook ordering (F-02)
const { assignDeviceProfile } = await import("../device-assignment.js");
const { loadDeviceEntitlements } = await import("../subscriptions.js");
const { handleSubscriptionDeleted, handleSubscriptionUpdated } = await import("../stripe-events.js");
// seed: one active subscription (extra_seats 0), devices 1–3 on it, device 4 with subscription_id null,
// one AUTO connection profile.
expect((await loadDeviceEntitlements(db, "acct-1", devices)).get(uuid(4))).toBeNull();
await assignDeviceProfile(db, {}, { id: "user-1" }, uuid(4), PROFILE);          // 200
// provisioning_jobs now contains CREATE_USER for device 4.

await handleSubscriptionDeleted(db, { id: "sub_p" }, {});
await handleSubscriptionUpdated(db, { id: "sub_p", status: "active", cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1893456000, price: { id: "price_pack" }, quantity: 2 }] } }, "price_pack", {});
// subscriptions row: status "active", extra_seats 6.

// admin disable (F-07): two vpn_accounts rows for user-1 → POST /api/admin/customers/user-1/disable → 500.
// legacy member (F-12): setExtraPacks(db, env, { id: "member-1" }, "1", 17) → 200 and
// stripe.subscriptions.update("sub_p", { items: [{ price: "price_pack", quantity: 17 }], ... }).
```

## Appendix B — lease pool exhaustion (SQL, local replay)

```sql
-- node-x reports 32 live slots; one account cycles login → authorize → logout 40 times.
select public.agent_sync_lease_slots('node-x', (select jsonb_agg(jsonb_build_object('slot', g, 'generation', 1,
  'valid_until', now() + interval '30 minutes', 'credential_ciphertext', '\x01', 'credential_nonce', '\x02'))
  from generate_series(0,31) g));
-- loop: insert device → lease_route_slots(null, dev, acct, 'r1-route-x', array['node-x'], 600, 20, 60, 600)
--       → mark device REVOKED → revoke_device_leases(dev, false)
-- Result: 32 leases granted, attempt 33 -> 'exhausted', 0 active slots left for other accounts.
```

## Appendix C — environment notes

- Local DB: PostgreSQL 16.13 with Supabase-like roles and default privileges; hosted Supabase runs Postgres 17.
- Browser: Chromium 1194 via Playwright, static export served by `python3 -m http.server` (no compression).
- singbox-vpn `5cee2fa` and tamara-next `a57060b` were cloned shallow and read only.
