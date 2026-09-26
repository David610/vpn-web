# ADR-0003: Ephemeral managed authorization (per-node lease pool)

> Status: ACCEPTED, implemented (Sub-project B2). vpn-web: migration
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
  restart.
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
(default 1800, clamped 900..7200), rounded up to a 60 s grid so slots
minted together expire together.

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
   real, node-enforced end of the credential. Leases therefore last
   between 10 and 30 minutes with defaults.
3. **Enforce on the node, with or without the control plane.** Each slot
   user carries `expires_at = valid_until` in vpn-admin's store, so any
   render after that instant drops it. The agent's sweeper runs every poll
   iteration (default 3 s) and rotates (new secret, generation + 1, one
   apply) every slot that is
   - expired (`valid_until <= now`) — needs no control plane;
   - reported `revoked` by the control plane;
   - reported `active` by a control-plane snapshot taken after its
     leasable window closed (so it provably was never leased), or never
     reported at all and past that window (nobody can hold it).
   The lease table survives agent restarts; on start the agent re-applies
   it once (a no-op if the live config already matches).
4. **Revocation.** `revokeDevice` (every path that revokes a device,
   e.g. `DELETE /v1/devices/{id}`) calls `revoke_device_leases`, which marks the
   device's live leases and their slots `revoked`. The node rotates them
   on its next sync (seconds), which is what actually stops the
   credential. If the control plane is down, revocation waits for the
   slot's `valid_until` (≤ lifetime). Entitlement loss without device
   revocation does not revoke live leases: `authorize` refuses new ones,
   and existing ones end at their `expires_at` (≤ 30 min by default).
5. **Bounded.** The pool is exactly N slots; slots the node drops are
   deleted server-side. `valid_until` more than 2 h ahead is rejected by
   the sync endpoint, so a buggy node cannot publish long-lived secrets.
   Rendered sing-box config grows by at most N users.

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
  and 60 per account per 10 minutes (replays and failed attempts don't
  count). Over the limit: `429 rate_limited` with `Retry-After: 600`.

### Privacy

Slots are named `lease-NNNN`; their subscription-token hash is of a random
token that is discarded, so no subscription URL reaches them. The node
never learns which device holds a slot. The only device↔slot link is
`vpn_leases`, service-role only (RLS enabled, all privileges revoked from
`anon`/`authenticated`, RPCs not executable by them). Secrets are never
logged: agent types that hold them have redacting `Debug`, vpn-admin
reports only lengths on failure, the sync endpoint logs only DB error
messages.

## Connections at expiry, rotation and renewal (measured, not assumed)

Measured on a real sing-box 1.14.1 server (evidence doc):

- After a slot rotates, **new** connections with the old credential are
  refused on both VLESS-REALITY and Hysteria2; the new generation works.
- Every apply restarts sing-box, and **a restart cuts every open
  connection on the node** — including connections of *other* users whose
  credentials did not change (a server-paced stream through an untouched
  slot was cut at the restart). So:
  - an open connection using an expired/revoked credential does not
    outlive the rotation apply (≤ one poll interval after `expires_at`);
  - each apply also drops everyone else's connections on that node once.
    Grid-aligned `valid_until` batches rotations: in steady state a node
    applies roughly twice per slot lifetime (window close for unleased
    slots, expiry for leased ones), plus one apply per revocation.
    Clients must reconnect transparently. Connection-preserving user
    updates need a sing-box API that 1.14.1 does not have; this is the
    main cost of the design and the reason the lifetime default is
    30 min and not 5.

**Renewal:** there is no in-place extension. The client calls `authorize`
again (new `client_request_id`) before `expires_at` — recommended at
`expires_at - 2 min`, or on any disconnect when less than that remains —
gets a new slot, and reconnects. Because the old slot's rotation restarts
the node anyway, the client should expect one reconnect per lease.

## tamara-next contract changes

`POST /v1/vpn/authorize`:

- Request: `{ "route_id": "...", "client_request_id": "..."? }`. Send a
  fresh random `client_request_id` per logical attempt and reuse it for
  network retries of that attempt.
- 200: unchanged shape, `{ route_id, expires_at, credential_envelope:
  { version: 1, hops: [...] } }`, hops in route order:
  - `vless-reality` hop → `{ "uuid": "..." }`
  - `hysteria2` hop → `{ "password": "..." }`, plus `"obfsPassword"`
    when that route hop has `hysteria2_obfs_type`.
  `expires_at` is now a real server-side end (10–30 min ahead): after it
  the credential is refused. The client must not cache or reuse
  credentials past it and must renew as above.
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
- Capacity: a node serves at most about N new leases per slot lifetime
  window (N=32 → ~32 per 20 min per node). Raise `lease_pool_size` on busy
  nodes; each slot costs one sing-box user entry.
- Every node must run an agent with this version before managed clients
  can authorize routes through it (no slots → `503 capacity_exhausted`).
- Rotation restarts sing-box (see above).
