# ADR-0002 Sub-project B: `POST /v1/vpn/authorize` — Design Spec

> Status: APPROVED (design decision made via AskUserQuestion during this
> session: reuse existing `vpn_accounts` identities, vpn-web-only this
> pass). Plan and execution pre-approved by the user; this doc records the
> design so the plan has a spec to argue from, per house process.

## Problem

`tamara-next` (the built Flutter client) calls `POST /v1/vpn/authorize`
with `{ route_id }` (a route id from the just-shipped `GET /v1/routes`,
Sub-project A) and expects back short-lived, per-connection, pseudonymous
per-hop credentials. `vpn-web` has no such endpoint today. This is
Sub-project B of ADR-0002 (`docs/ADR/0002-managed-client-route-contract.md`).

## Contract (from `tamara-next/docs/contracts/managed-control-plane-v1.md`,
authoritative, not restated/forked)

Request (authenticated like every `/v1` route — `Authorization: Bearer`):
```json
{"route_id": "de-privacy-1"}
```
Response 200:
```json
{
  "route_id": "de-privacy-1",
  "expires_at": "2026-09-13T10:15:00Z",
  "credential_envelope": {"version": 1, "hops": [{"uuid": "..."}, {"uuid": "..."}]}
}
```
- `route_id` echoes the request, ≤160 chars.
- `credential_envelope.hops` has one entry per route hop (1 for `fast`,
  2 for `privacy_plus`, entry/relay hop first — same order as `GET
  /v1/routes`'s `hops` array).
- Envelope must never contain account email, account id, billing/payment
  id, or subscription id.
- Failure semantics (shared across `/v1`): 401/403 = session invalid;
  429/5xx = bounded temporary failure, client retries later, never
  silently downgrades Privacy+ to Fast; malformed payload = fail closed.

## The gap this spec resolves

`vpn-web`'s only credential model today is `vpn_accounts`: one row per
`(device_id, node_id)`, created asynchronously by a `CREATE_USER`
`provisioning_jobs` row that a remote node agent polls and applies —
there is no synchronous, short-lived, per-connection credential mint.
Building real ephemeral per-connection identities would require changing
`singbox-vpn`'s provisioning-agent contract (Rust, no toolchain available
this session — same constraint that scoped Sub-project A to vpn-web-only).

**Decision (user-confirmed):** `authorize` resolves a `route_id` to
concrete node(s) using the existing scheduler, then returns the device's
existing `vpn_accounts` identity on each node as the credential. If an
identity does not exist yet on a resolved node, `authorize` enqueues the
same `CREATE_USER` job the existing provisioning path already uses (the
DB already guarantees at most one in-flight `CREATE_USER` per
`(device_id, node_id)` — safe to enqueue from two call sites) and returns
503 for this call, letting the client retry. `expires_at` is a short,
advisory TTL (15 minutes) on the *response*, matching the contract's
example — it is not a claim that the underlying `vpn_accounts` credential
itself rotates that fast. Real per-connection rotation is deferred to a
documented Sub-project B2 that needs `singbox-vpn` Rust work.

This is scoped, reversible, and ships real security value now (the
pseudonymity and per-hop-credential-shape requirements are met in full;
only the "short-lived" property is currently advisory rather than
enforced) without inventing new node-side infrastructure blind.

## Design

### 1. Resolving `route_id` to node(s)

Route ids are deterministic, not stored (Sub-project A: `` `${cc}-fast` ``
or `` `${entryCc}-${exitCc}-privacy` ``, 2-letter lowercase country
codes). Parse with two patterns:
- `^([a-z]{2})-fast$` → single EXIT location by country code.
- `^([a-z]{2})-([a-z]{2})-privacy$` → RELAY (entry) + EXIT (exit)
  locations by country code.

Anything else → 400. A parsed code with no matching **enabled** `locations`
row → 409 `route_not_found` (fail closed, mirrors the "missing item is
409, never 404" `/v1` convention already documented in `v1-http.js`).

### 2. Node selection

Reuse `functions/lib/scheduler.js`'s existing, tested DB-facing wrappers
rather than re-deriving eligibility:
- `fast` → `scheduleNodeForDevice(db, { deviceId, exitLocationId })`.
- `privacy_plus` → `scheduleDoubleHopForDevice(db, { deviceId,
  entryLocationId, exitLocationId })`.

Both already fail closed (return `null`) when no enabled `allowed_paths`
row or no capacity-eligible node exists, and already persist a sticky
`device_node_assignments` row — reusing them means `authorize` never
grants a route the scheduler wouldn't otherwise allow, and repeated
`authorize` calls for the same device tend to keep resolving to the same
node (stable identity, no needless `CREATE_USER` churn).

**Known pre-existing gap, not fixed here (ledgered, not fixed):**
`renderRoutes()` (Sub-project A) advertises a `fast` route for *every*
enabled location with an eligible EXIT node, without checking for an
enabled direct `allowed_paths` row — but `scheduleNodeForDevice` *does*
require one. A location `GET /v1/routes` lists as `fast` could therefore
get 503 from `authorize` if no direct `allowed_paths` row exists for it.
This is stricter (fails closed), never grants more than intended, and is
a documented follow-up against Sub-project A's route-listing, not
something Sub-project B should silently paper over by loosening its own
authorization check.

`null` from either scheduler call → 503 (temporarily unavailable; matches
contract's failure semantics — client may retry, never told to downgrade
Privacy+ to Fast by this response, only by exhausting all Privacy+ routes
client-side).

### 3. Entitlement check

`authorize` must never issue credentials to a device whose subscription
isn't live. Reuse `functions/v1/entitlement.js`'s existing pattern
(`loadDeviceEntitlements`) before any route/node resolution. No
entitlement → 409 `not_entitled` (not 403 — `v1-http.js`'s own header
comment reserves 401/403 for "session no longer valid, sign the app out",
which billing lapse is not).

### 4. Credential resolution per hop

For each resolved node id, in hop order (relay first for `privacy_plus`):
- Look up `vpn_accounts` for `(device_id, node_id)` where `enabled =
  true`, select `vpn_user_id`.
- Found → use it as that hop's `{ uuid: vpn_user_id }`.
- Missing → enqueue a `CREATE_USER` job with the same payload shape
  `reconcileDeviceProvisioning` already uses (`device-provisioning.js`
  lines ~225-241: `{ user_id, device_id, expires_at? }`), idempotency key
  `` `authorize:create:${device.id}:${nodeId}` ``. The DB's
  `provisioning_jobs_one_inflight_create_per_device_node` unique index
  (migration `20260925010000_device_identities.sql`) makes this safe to
  call even if `reconcileDeviceProvisioning` already has one in flight for
  the same pair — one of the two inserts loses the race with `23505`,
  already the established "already enqueued" signal. Whenever any hop is
  missing an identity, the whole request returns 503 (never a partial
  credential envelope with only some hops populated) — the enqueue still
  happens for every missing hop before returning, so a client retry a few
  seconds later has strictly better odds, not just the first missing hop.

### 5. Response

`200` with `{ route_id, expires_at, credential_envelope: { version: 1,
hops: [{ uuid }, ...] } }`. `expires_at = now + 15 minutes` (`AUTHORIZE_TTL_MS`
constant). No account/billing identifier anywhere in the envelope by
construction — `vpn_user_id` is already `vpn-web`'s existing pseudonymous
identifier, never account email/id/subscription id.

## Files

- New `functions/lib/vpn-authorize.js` — `authorizeRoute(supabaseAdmin,
  env, { device, entitlement, routeId })`, pure orchestration over
  injected `supabaseAdmin` (same testing style as `device-provisioning.js`),
  returns a discriminated result (`{ ok: true, routeId, expiresAt,
  credentialEnvelope }` or `{ ok: false, status, message, code? }`) —
  never throws for expected failure modes, only for genuine DB errors
  (matches every other `lib/*.js` convention in this codebase).
- New `functions/v1/vpn/authorize.js` — `onRequestPost`, wires
  `readV1Json`/`withV1User`/`ensureSessionDevice`/`loadDeviceEntitlements`
  to `authorizeRoute`, maps its result to `v1Json`/`v1Error`.
- Modify `functions/lib/device-provisioning.js` — export a small helper,
  `buildCreateUserJob(device, entitlement)`, factoring the exact payload
  object `reconcileDeviceProvisioning` already builds inline (lines
  ~226-230) so `vpn-authorize.js` builds an identical payload without
  duplicating the `clearExpiry`/`serviceExpiresAt` branching. This is the
  one existing-file change; it is a pure extraction (same object shape,
  same fields), not a behavior change to `reconcileDeviceProvisioning`.
- Tests: `functions/lib/__tests__/vpn-authorize.test.js`,
  `functions/v1/vpn/__tests__/authorize.test.js`, plus additions to
  `functions/lib/__tests__/device-provisioning.test.js` for the extracted
  helper.

No new migration — every table used (`vpn_accounts`, `provisioning_jobs`,
`device_node_assignments`, `devices`, `locations`, `allowed_paths`)
already exists with the needed columns/constraints.

## Testing

- `vpn-authorize.test.js`: invalid route_id format (400); unknown/disabled
  location (409 `route_not_found`); no entitlement is checked here (that's
  the route handler's job — this module receives `entitlement` already
  resolved) — actually covered: fast route with no allowed_paths row
  (503); fast route with existing identity (200, single hop); privacy
  route with both identities existing (200, two hops, relay first);
  privacy route missing one identity (503, and a `CREATE_USER` job is
  observably enqueued for the missing hop only); privacy route missing
  both identities (503, two jobs enqueued); a second call while a
  `CREATE_USER` job is already in flight does not error (23505 swallowed,
  matches `insertJob`'s existing convention) and still returns 503.
- `authorize.test.js` (route handler): 400 on missing/oversized/non-string
  `route_id`; 409 `not_entitled` when `loadDeviceEntitlements` returns
  nothing for the device; 200 happy path shape assembly
  (`route_id`/`expires_at`/`credential_envelope` field names exactly as
  contracted); auth failure delegates to `withV1User` (401), matching
  every other `/v1` route's test pattern (see `functions/v1/__tests__/routes.test.js`).

## Review Focus

- A `route_id` whose two location halves are identical
  (`"de-de-privacy"`) with an enabled `allowed_paths` row where
  `entry_location_id = exit_location_id` — should resolve normally
  (nothing in this design forbids a same-country double hop); confirm the
  scheduler doesn't special-case this into an accidental failure.
- A `route_id` that is syntactically a valid `fast` pattern but whose
  country code belongs to a `locations` row with `enabled = false` — must
  be 409, not 500 (the location lookup query must filter `enabled = true`
  explicitly, not rely on the nodes query already filtering).
- Two concurrent `authorize` calls for the same device+route racing to
  enqueue the same `CREATE_USER` job — the second must see `23505` and
  still return a clean 503, not surface a raw DB error to the client.
- A device with an entitlement whose `clearExpiry` is false but
  `serviceExpiresAt` is (unexpectedly) null — `reconcileDeviceProvisioning`
  already throws in this case (a pre-existing invariant); `vpn-authorize.js`
  must not swallow that into a misleading 503 — let it propagate to
  `withV1User`'s catch-all (503 "Arcana is temporarily unavailable",
  logged server-side), same as any other unexpected error in this codebase.
- A `privacy_plus` route where the relay hop has an existing identity but
  the exit hop does not (or vice versa) — the response must still be a
  clean single 503 with both statuses' side effects (job enqueue) applied
  once each, never a credential envelope with one real hop and one
  missing/undefined entry.

## Non-goals

- Real ephemeral per-connection identity rotation on the node side
  (`singbox-vpn` changes) — Sub-project B2, needs a Rust-toolchain
  session.
- Fixing the `renderRoutes()`/`allowed_paths` fast-route gap noted above
  — logged as a follow-up against Sub-project A, out of scope here.
- Rate limiting `POST /v1/vpn/authorize` beyond what Cloudflare/existing
  `/v1` middleware already provides — the contract only specifies generic
  429 handling, no numeric quota.
