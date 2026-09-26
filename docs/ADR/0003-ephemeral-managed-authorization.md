# ADR-0003: Ephemeral managed authorization (per-node lease pool)

> Status: ACCEPTED, implemented (Sub-project B2). Revised 2026-09-26:
> in-place renewal and batched rotation bound node-wide disconnects
> (sections "Renewal extends", "Bounding disruption"). vpn-web: migration
> `supabase/migrations/20260929000000_ephemeral_lease_pool.sql`,
> `functions/lib/vpn-authorize.js`, `functions/api/agent/leases/sync.js`.
> singbox-vpn: `vpn-admin lease-pool sync`
> (`apps/admin/src/lease_pool.rs`), agent lease store + sweeper
> (`apps/provisioning-agent/src/lease_pool.rs`). Real-server evidence:
> singbox-vpn `docs/B2_EPHEMERAL_AUTH_EVIDENCE.md`.

## Context

ADR-0002 made `POST /v1/vpn/authorize` return `expires_at = now + 15 min`,
but the credentials it returned were the device's long-lived
`vpn_accounts.vpn_user_id` identities, created by `CREATE_USER`
provisioning jobs and valid until the subscription ended. `expires_at`
was advisory: a leaked or retained credential kept working for months.

We want managed (tamara-next) credentials to be short-lived **on the
server**: a credential stops being accepted by the node at a known time,
whether or not the client cooperates, and whether or not the control
plane is reachable at that moment.

Constraints:

- sing-box 1.14.1 (pinned in singbox-vpn `deploy/lib/versions.env`) has no
  runtime API to add/remove VLESS or Hysteria2 users. The only way to
  change who may authenticate is to render a new config and restart the
  service (singbox-vpn's existing fail-closed apply: state lock, render,
  `sing-box check`, atomic rename, `systemctl reload-or-restart`, health
  verification, rollback). The unit has no `ExecReload`, so this is a
  restart, and a restart drops **every** open connection on the node, not
  just the changed user's. sing-box's own SIGHUP reload keeps the process
  but re-creates the inbounds and drops every open connection too
  (measured, see below), so it is no cheaper and is not used.
- A credential must work *before* the client is told about it (no
  "authorized but can't connect yet" window).
- Nothing in a credential or in node config may identify a person:
  no email, account id, subscription id or Stripe object.
- Privacy+ routes need one credential per hop, and a one-hop partial
  must never be returned for a two-hop route.

## Decision

### Lease pool

Every node's provisioning agent keeps a bounded pool of **N pseudonymous
slots** (`lease_pool_size`, default 32, max 1024; `0` disables). A slot is
a random VLESS uuid + random 192-bit Hysteria2 password, rendered into
sing-box as a user named `lease-NNNN`. Each slot *generation* has a hard
end, `valid_until`, chosen by the node: `now + lease_slot_lifetime_secs`
(default 1800, clamped to `max(900, 600 + batch + 60)..7200`) **floored**
onto the node's rotation grid (`rotation_batch_interval_secs`, default
600, clamped 60..3600). Every `valid_until` therefore lies on a batch
boundary, never later than `now + lifetime`, never more than 2 h ahead.

1. **Mint → apply → report.** The agent writes the new generation to its
   local lease table (0600, atomic rename, fsync) *before* applying it, runs
   `vpn-admin lease-pool sync` (single-writer, fail-closed apply), and only
   after that reports a sing-box that is provably live does it report the
   generation to `POST /api/agent/leases/sync`. The control plane stores
   the secret AES-GCM-encrypted (`VPN_SECRETS_ENCRYPTION_KEY`, same as
   `vpn_secrets`) and marks the slot `active`. So every leasable slot
   has already been observed live on the node.
2. **Lease.** `authorize` calls the `lease_route_slots` RPC with the route's
   exact hop node ids (from ADR-0002's physical route binding). In one
   transaction it picks, for each hop, an `active` slot with at least
   `minRemainingSeconds` (600) left, `FOR UPDATE SKIP LOCKED`. If any hop
   has none it returns `exhausted` **without writing anything** (no
   partial). Otherwise all chosen slots become `leased` (single-use per
   generation) and one `vpn_leases` row records `(device, route, hops,
   expires_at)`. `expires_at` = the earliest hop's `valid_until`: the
   real, node-enforced end of the credential. A fresh lease lasts between
   10 and 30 minutes with defaults; renewal (below) extends it in place.
3. **Enforce on the node, with or without the control plane.** Each slot
   user carries `expires_at = valid_until` in vpn-admin's store, so any
   render after that instant drops it. The agent's sweeper runs every poll
   iteration (default 3 s) and decides which slots get a new generation
   (new secret, generation + 1):
   - **expired** (`valid_until <= now`) — immediately; needs no control
     plane. Because `valid_until` is on the grid, this is always at a
     batch boundary;
   - reported `revoked` **with `urgent`** — immediately;
   - reported `revoked` without `urgent`, or `active` in a control-plane
     snapshot taken after its leasable window closed (provably never
     leased), or never reported and past that window — **deferred** to
     the first poll after the next grid boundary since the last rotation.
   An immediate rotation takes every deferred one along (the restart is
   paid anyway). So non-urgent rotations cost at most one apply (= one
   sing-box restart) per batch window; each urgent revocation may add one.
   The lease table (including the last rotation time) survives agent
   restarts; on start the agent re-applies it once (a no-op, no restart, if
   the live config already matches).
4. **Revocation.** `revokeDevice` (every path that revokes a device,
   e.g. `DELETE /v1/devices/{id}`) calls `revoke_device_leases(device,
   urgent)`, which marks the device's live leases and their slots
   `revoked`. The node rotates them — which is what actually stops the
   credential — within seconds if `urgent`, otherwise at its next batch
   boundary (≤ `rotation_batch_interval` + one poll + apply, and never
   later than the lease's `expires_at`, which is itself on a boundary).
   `urgent` is set for admin actions against another person: an owner
   removing a member (`DELETE /api/account/members/{id}`) or revoking
   another member's device; operators use `select
   revoke_device_leases(id, true)` for abuse. A user removing their own
   device, signing out, or deleting their account is non-urgent for their
   own devices; account deletion revokes other members' devices urgently
   (the owner is acting against another person, as when removing a member).
   `lease_route_slots` re-checks `devices.status` under the same per-device
   lock `revoke_device_leases` takes, so no lease can be minted, renewed or
   replayed for a device whose revocation raced the authorize call. If the
   control plane is down, revocation waits for the slot's `valid_until`.
   Entitlement loss without device revocation does not revoke live leases:
   `authorize` refuses new ones and renewals, and existing ones end at
   their `expires_at` (≤ 30 min by default).
5. **Renewal extends, it does not rotate.** When a device calls
   `authorize` for a route on which it already holds a live lease (not
   revoked, every slot still leased by it at the same generation, at least
   60 s left), `lease_route_slots` takes no new slot: it sets the lease's
   `expires_at` and each slot's `extend_to` to
   `T = min over hops of floor((now + min(30 min, node lifetime)) / node grid) * node grid`
   (the node's grid and lifetime come from `node_lease_policy`, reported
   by the agent on every sync), never shortening the lease, and returns the
   **same credentials** with the new `expires_at`. The agent sees
   `extend_to` on its next sync (≤ 3 s) and moves the slot's `valid_until`
   to `min(floor(extend_to), floor(now + lifetime))` — never backwards,
   only for a leased, unexpired, current generation. That changes only
   `expires_at` in vpn-admin's user store; the rendered sing-box config is
   byte-identical, so vpn-admin reports "already current" and **sing-box
   is not restarted**. Renewals create no lease row and do not count
   toward the rate limit. Security bound: the node never enforces a later
   end than the `expires_at` it was told; if it does not learn of a
   renewal in time (control plane down) the credential ends earlier, at
   the old `valid_until` (a liveness failure, never a lifetime extension).
6. **Bounded.** The pool is exactly N slots; slots the node drops are
   deleted server-side. `valid_until` more than 2 h ahead is rejected by
   the sync endpoint, so a buggy node cannot publish long-lived secrets.
   Rendered sing-box config grows by at most N users.

### Pool sizing

A slot is never leased to a second device until its secret has rotated:
`leased`/`revoked` slots are single-use per generation, and only a new
generation — reported after the node applied it live — becomes `active`.
With batching, a freed slot (expired, revoked or unleased-past-window)
comes back only after the next boundary. A node therefore needs
`lease_pool_size ≥ peak concurrent leases + slots freed per batch window
+ margin`. Renewing clients hold one slot indefinitely and cost nothing
more; a client that stops renewing frees its slot at its `expires_at`.
When the pool is empty `authorize` returns `503 capacity_exhausted`
without writing anything.

### Hysteria2 obfs password

tamara-next's envelope requires `obfsPassword` for hysteria2 hops whose
published hop declares `hysteria2_obfs_type`. That is a per-node secret
(salamander), not per-lease. `vpn-admin lease-pool sync` returns it to the
agent on stdout; the agent sends it in the sync body whenever it changes
(and once per process start); vpn-web stores it encrypted in
`node_transport_secrets`. `authorize` resolves it *before* leasing; if it
is missing it returns 503 `route_not_ready` and consumes no slot.

### Idempotency and rate limiting

- `client_request_id` (optional, 8–64 chars `[A-Za-z0-9_-]`) makes retries
  safe: key = `sha256("vpn-authorize:v1:" + device_id + ":" + route_id +
  ":" + client_request_id)` (the raw value is never stored). A retry while
  the lease is live and its slots unchanged returns the identical
  response and burns no slot. An expired or revoked lease is never
  replayed; the key is released and the retry gets a fresh lease. A key
  reused for a different route/device is `409 idempotency_conflict`.
- vpn-web had no request limiter to reuse, so the limit lives in the same
  RPC, under a per-device advisory lock: at most 20 new leases per device
  and 60 per account per 10 minutes (replays, renewals and failed
  attempts don't count). Over the limit: `429 rate_limited` with `Retry-After: 600`.

### Privacy

Slots are named `lease-NNNN`; their subscription-token hash is of a random
token that is discarded, so no subscription URL reaches them. The node
never learns which device holds a slot. The only device↔slot link is
`vpn_leases`, service-role only (RLS enabled, all privileges revoked from
`anon`/`authenticated`, RPCs not executable by them). Secrets are never
logged: agent types that hold them have redacting `Debug`, vpn-admin
reports only lengths on failure, the sync endpoint logs only DB error
messages.

## Bounding disruption (measured, not assumed)

Measured on a real sing-box 1.14.1 server (singbox-vpn
`docs/B2_EPHEMERAL_AUTH_EVIDENCE.md`):

- After a slot rotates, **new** connections with the old credential are
  refused on both VLESS-REALITY and Hysteria2; the new generation works.
- Every rotation apply restarts sing-box, and **a restart cuts every open
  connection on the node**, including other users' whose credentials did
  not change. `kill -HUP` (sing-box's in-process reload) keeps the PID but
  also cuts every open connection, so it is not a cheaper apply path.
- **Renewal costs no restart**: a 10-minute server-paced stream stayed
  open across the credential's original `valid_until` after a renewal;
  the same credential still opened new connections 30 s past it; 0
  sing-box restarts, PID unchanged.
- **Batching bounds restarts**: 16 non-urgent revocations in 8 minutes on a
  120 s test grid caused 5 restarts, exactly one per grid window.
- **Urgent revocation** is applied within seconds: refused ~5–7 s after the revoke, with a pending
  non-urgent revocation carried along in the same single restart; the
  non-urgent one alone was still accepted 17 s after revocation
  (deferred to the next boundary, as designed).
- **Expiry needs no control plane**: with the control plane stopped and the agent
  restarted mid-lease (no restart caused by that), the credential passed
  40 s before `expires_at` and was REFUSED (VLESS and Hysteria2) from
  2.8 s after it.

What `expires_at` means, exactly: the last moment the credential can open
a NEW connection is `expires_at` + the enforcement latency (the next agent
poll, ≤ 3 s by default, plus one apply, ~1.5 s measured). Because every
`valid_until` sits on a batch boundary, expiry is never deferred by
batching — there is no "expired but waiting for the batch" window. What
batching defers is only non-urgent revocation (and rotation of slots
nobody holds): a non-urgently revoked credential keeps working until the
next boundary (≤ `rotation_batch_interval`, default 10 min), and never
past its `expires_at`. Stock sing-box 1.14.1 cannot reject one user
without re-creating its inbounds, so nothing tighter is possible without
a restart; the urgent flag exists for the cases that must not wait.
Connections that are already open when their credential expires or is
revoked are cut at that rotation apply (together with everyone else's on
the node).

Steady-state cost per node: at most one restart per batch window (default
10 min), and zero while every leaseholder keeps renewing and no slot
expires or is revoked, plus one per urgent revocation. Clients must
reconnect transparently after a restart.

## tamara-next contract changes

`POST /v1/vpn/authorize`:

- Request: `{ "route_id": "...", "client_request_id": "..."? }`. Send a
  fresh random `client_request_id` per logical attempt and reuse it for
  network retries of that attempt.
- 200: unchanged shape, `{ route_id, expires_at, credential_envelope:
  { version: 1, hops: [...] } }`, hops in route order (tamara-next's merged
  client contract; `functions/lib/vpn-authorize.js` `hopCredential`):
  - `vless-reality` hop → `{ "uuid": "..." }`
  - `hysteria2` hop → `{ "password": "..." }`, plus `"obfsPassword"`
    when that route hop has `hysteria2_obfs_type`.
  If the node has not reported its obfs password the request fails closed
  with `503 route_not_ready` (no slot consumed); an unknown transport is a
  500, never a partial hop.
  `expires_at` is now a real server-side end (10–30 min ahead): a new
  connection with the credential is refused from `expires_at` + a few
  seconds (next agent poll + apply) on. The client must not use
  credentials past it.
- **Renewal**: call `authorize` again for the same `route_id` before
  `expires_at` (recommended at `expires_at - 5 min`, at least 60 s before;
  a fresh `client_request_id`). The response carries the **same
  credentials** and a later `expires_at`; the client keeps its open
  connection and must not reconnect. If the credentials differ (the lease
  could not be renewed: too close to the end, revoked, or its slot already
  rotated), reconnect with the new ones.
- New / changed errors (`{ message, code }`):
  - `409 route_stale` — unchanged: refresh the directory (the client's
    existing "refresh, max 2" handling applies).
  - `503 capacity_exhausted` — a hop's pool is empty; retry with backoff
    or pick another route.
  - `503 route_not_ready` — a node hasn't reported its obfs secret yet;
    retry with backoff.
  - `429 rate_limited` + `Retry-After` seconds.
  - `409 idempotency_conflict` — client bug (id reused for another route).
  - `400` — malformed `route_id` / `client_request_id`.
- The previous 503 "credentials are being provisioned" path is gone:
  authorize no longer enqueues `CREATE_USER`.

## Consequences

- Managed credentials are now genuinely short-lived and revocable
  within seconds. Long-lived `vpn_accounts` identities remain only for
  legacy subscription-URL clients (unchanged).
- Capacity: a node holds at most N concurrent leases (renewals keep a
  slot), minus slots awaiting their batch rotation; see "Pool sizing".
  Raise `lease_pool_size` on busy nodes; each slot costs one sing-box user
  entry.
- Every node must run an agent with this version before managed clients
  can authorize routes through it (no slots → `503 capacity_exhausted`).
- Rotation restarts sing-box (see above); renewal and batching bound how
  often. Connection-preserving user changes need a sing-box user API that
  1.14.1 lacks; if a later pinned version gains one, the batch window can
  shrink to zero without changing the contract.
