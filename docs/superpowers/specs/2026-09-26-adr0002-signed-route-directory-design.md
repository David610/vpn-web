# ADR-0002 Sub-project A: Signed Route Directory (`GET /v1/routes`)

Status: approved design, pending implementation plan
Repos affected: `vpn-web` (control plane, primary) and `singbox-vpn`
(provisioning agent, one bootstrap-reporting addition only).
Corresponds to: `docs/ADR/0002-managed-client-route-contract.md`'s decision
that `vpn-web`'s `/v1` backend adopts `tamara-next`'s signed route
directory + pseudonymous authorization contract. First of three
sub-projects this work is decomposed into:

- **A (this spec):** Ed25519 signing infrastructure + `GET /v1/routes`.
- **B (separate spec, later):** `POST /v1/vpn/authorize` — per-connection
  pseudonymous credential issuance. Needs its own design pass; today's
  per-node credential model (`CompatUser`/`peer_credentials`) is
  per-device, not per-connection/short-lived.
- **C (separate spec, later):** Interop testing against `tamara-next`'s
  already-built `RouteDirectoryVerifier`/`CachingRouteDirectoryClient`.

The authoritative contract shapes are `tamara-next/docs/contracts/managed-control-plane-v1.md`
and its real client implementation, `tamara-next/lib/infrastructure/control_plane/signed_route_directory.dart`
(read directly for this spec, not restated from memory). This spec does
not fork or reinterpret those shapes — where this document and that repo
disagree, the client code is authoritative, since it is real, tested, and
not being changed by this work.

## 1. Problem

`vpn-web`'s database has no record of any node's REALITY/Hysteria2
transport parameters (public key, port, TLS server name) — confirmed by
direct migration search, not assumed. Today the only thing `vpn-web` ever
hands a client is an opaque `subscription_url`; the actual transport
config is rendered entirely inside `singbox-vpn`'s `compat-config` crate
from data that never leaves the node. `tamara-next`'s already-built,
already-tested `RouteDirectoryVerifier` expects a signed, versioned,
rollback-protected directory of concrete routes with real hop data
(`GET /v1/routes`) — nothing in `vpn-web` can produce that today.

## 2. Goals

- Close the transport-parameter gap: `vpn-web` learns each node's public
  REALITY (and, where applicable, Hysteria2) parameters once, at
  bootstrap, without the node's private key ever leaving the VPS.
- Serve `GET /v1/routes` exactly matching `tamara-next`'s contract: an
  Ed25519-signed, schema-versioned, monotonically-versioned envelope,
  byte-identical canonical JSON to what `RouteDirectoryVerifier` already
  verifies.
- Reuse the fleet's existing node/location/`allowed_paths`/scheduler data
  and logic to decide *which* routes exist and *which* node backs each one
  — no second source of truth for routing decisions.

## 3. Non-goals (deferred)

- `POST /v1/vpn/authorize` and any per-connection credential issuance —
  Sub-project B.
- Real interop testing against `tamara-next`'s client — Sub-project C
  (this spec's own testing section covers `vpn-web`-side correctness only:
  a same-language round-trip test that signs and re-verifies, not a
  cross-repo Dart/JS interop run).
- Key rotation tooling/runbook (the contract already supports multiple
  concurrent trusted keys client-side for "planned overlap during key
  rotation" — this spec issues one key and documents the shape rotation
  will need, but does not build rotation automation).
- Hysteria2 hop rendering beyond what the schema already allows — no
  currently-shipped node uses Hysteria2 as its primary transport (per
  `docs/FLEET_LIFECYCLE_AUTOMATION.md` and the provider adapter), so this
  is schema-compatible but untested with real data until one exists.

## 4. Design

**Dependency:** this design assumes `install.sh` actually reaches the
point of generating a REALITY keypair during automated bootstrap. It
didn't — `install.sh` requires `REALITY_HANDSHAKE_SERVER` (or
`--reality-handshake-server`) and refuses to guess a default, and
`node-bootstrap.js`'s `--non-interactive` invocation never supplied it, so
INSTALL would fail on every automated node before ever reaching REALITY
setup. Fixed as its own, unrelated piece of work (`FLEET_REALITY_HANDSHAKE_SERVER`,
threaded through `buildNodeBootstrapUserData`) — merged before this spec's
implementation plan, so §4.1 below can assume INSTALL actually succeeds.

### 4.1 Node transport-parameter reporting (`singbox-vpn` + `vpn-web`)

`singbox-vpn`'s `vpn-admin` already generates a node's REALITY keypair
idempotently during its own apply/bootstrap flow
(`generate_reality_keypair`, `apps/admin/src/main.rs`) and persists the
public half at `DeploymentConfig::reality_public_key_file()`. The gap is
purely reporting: this file is never sent anywhere.

`NODE_BOOTSTRAP.md`'s existing flow already has every stage report to
`POST /api/agent/bootstrap-status`. The `COMPLETE` stage's report gains an
optional `transport` object:

```json
{
  "stage": "COMPLETE",
  "status": "OK",
  "transport": {
    "transport": "vless-reality",
    "server_address": "<node's public hostname, already known to vpn-web>",
    "server_port": 443,
    "tls_server_name": "<the node's decoy domain>",
    "reality_public_key": "<hex, from reality_public_key_file()>",
    "reality_short_id": "<hex>",
    "reality_fingerprint": "chrome",
    "vless_flow": "xtls-rprx-vision"
  }
}
```

`functions/api/agent/bootstrap-status.js` persists these fields onto the
reporting node's `nodes` row (new, nullable columns — see 4.4). Only
public values ever cross the wire; the private key file never leaves the
VPS, the same security model already established for the node's
permanent API key (`NODE_BOOTSTRAP.md`'s Credentials table).

A node with no `transport` object (an older agent build, or the field
omitted) is simply excluded from route rendering (4.2) until it reports
one — fails closed, not with a broken/incomplete route.

### 4.2 What a route is (`vpn-web`)

A route's hop data must name one concrete, currently-reachable node's
real transport identity — REALITY requires the client to trust an exact
public key, so this cannot be a generic "a node in this location" stand-in.
`GET /v1/routes` therefore renders, per `(location, mode)` pair, whichever
node the scheduler's own pure selection logic
(`selectNodeForDevice` in `scheduler.js`) currently prefers for that
pool — **without** committing anything: no `device_node_assignments`
write, no sticky binding. That still only happens later, at actual
connection time (Sub-project B). A node backing a route today may not be
the node backing it after the directory's TTL elapses and a client
refetches — expected, not a bug, and exactly why the directory carries a
TTL and a version instead of being treated as permanent.

- **`fast`** (1 hop): one route per exit `location` that has at least one
  READY/CANARY EXIT node with transport params populated. Candidates
  reuse the exact same `isUnderCapacity`/lifecycle filtering
  `scheduleAutoForDevice` already applies; `selectNodeForDevice` picks the
  representative node for that location with `stickyNodeId: null`.
- **`privacy_plus`** (2 hops): one route per enabled `allowed_paths` row
  (entry × exit location pair), same candidate/selection logic run
  independently for the RELAY and EXIT pools, mirroring
  `scheduleDoubleHopForDevice`'s existing per-hop independence. A pair
  with no valid candidate for either hop is omitted entirely — never a
  half-populated route.
- Route `id`: `<location-country-code-lowercase>-<mode-slug>` for `fast`
  (e.g. `de-fast`), `<entry-country-code>-<exit-country-code>-privacy`
  for `privacy_plus` (e.g. `se-de-privacy`) — stable across the
  *specific* node changing underneath (replacement, canary promotion,
  scale-out), so a client's notion of "this is the Germany fast route"
  does not churn just because the node behind it does. A location or
  pair that could produce more than one route under the same id (not
  possible under today's one-scheduler-selection-per-pool model) is out
  of scope for this spec — would need a numeric suffix scheme like
  `nextScaleNodeId`'s, added only if that need actually arises.
- `label`/`region`: derived from the `locations` row(s) already backing
  the pool (`display_name`, `country_code`).
- `priority`: fixed `100` for every route this spec renders — no ranking
  signal exists yet to vary it, and the contract's client code treats it
  as an opaque sort hint, not a required differentiator.
- `failure_domain`: the winning node's `failure_domain` column
  (`fast`) or the exit node's (`privacy_plus`, matching how a double-hop
  failure domain is already reasoned about elsewhere) — omitted (not
  included, since the field is optional in the contract) when null.

### 4.3 Signing (`vpn-web`)

- **Key storage:** the Ed25519 private key (32-byte seed, hex-encoded) as
  a new Pages secret, `ROUTE_SIGNING_PRIVATE_KEY` — same treatment as
  every other secret this codebase already has (`HETZNER_API_TOKEN`,
  `STRIPE_SIGNING_SECRET`, ...). `ROUTE_SIGNING_KEY_ID` (a second secret
  or plain env var, e.g. `"routes-2026-a"`) is the `key_id` this key
  signs under, matching the contract's key-rotation-by-`key_id` model.
  Rotation itself (issuing a second key, retiring the first) is
  documented as a follow-up, not built here (§3).
- **Signing implementation:** Ed25519 via `@noble/curves`'s `ed25519`
  (already dependency-free, pure-JS, Workers-compatible — avoids
  depending on Workers' `SubtleCrypto` Ed25519 support, which is newer
  and inconsistently available across runtime versions). Added as a new
  `dependencies` entry.
- **Canonical JSON:** a direct port of `tamara-next`'s `_canonicalJson`
  (`signed_route_directory.dart`): recursively sort object keys, encode
  each leaf (string/number/bool/null) with `JSON.stringify`, join with
  no whitespace. `functions/lib/canonical-json.js`, pure, no I/O. The
  signed envelope's fields are constrained to never contain a
  floating-point number (only integers, strings, booleans) so
  Dart's and JS's numeric-to-string formatting can never diverge —
  enforced by construction (every numeric field this spec emits —
  `schema_version`, `directory_version`, `server_port`, `priority` — is
  an integer) and asserted in tests.
- **`directory_version`:** a single-row counter table,
  `route_directory_state (id boolean primary key default true check (id),
  version bigint not null default 0, last_payload_hash text)` (the
  `boolean primary key` trick guarantees exactly one row, same pattern
  other singleton-config tables could use — new to this codebase, but
  simple and self-documenting). On each `GET /v1/routes`, the handler
  renders **only** `payload.routes` (4.2) and hashes its canonical JSON
  (SHA-256) — deliberately excluding `issued_at`/`expires_at`, which
  differ on every call regardless of content and would otherwise force a
  version bump on every single request. Compared to `last_payload_hash`:
  unchanged → reuse the stored `version` and re-sign the full envelope
  with a fresh `issued_at`/`expires_at` window (the route content didn't
  change, but the signature's validity window still needs to advance);
  changed → increment `version`, store the new hash, sign. This makes
  `directory_version` a true content version (bumps only when the actual
  route topology visible to clients changes), not a request counter.
- **`issued_at`/`expires_at`:** a fixed 1-hour window, matching the
  contract's own example — `expires_at = issued_at + 1h`. No
  configurability in this pass (§3).
- **Envelope construction**, in order: render `payload.routes` (4.2) →
  compute/update `directory_version` → build the unsigned envelope
  (`schema_version: 1, directory_version, issued_at, expires_at, key_id,
  payload`) → canonicalize → sign → attach `signature` (base64) → return.
  Exactly mirrors `RouteDirectoryVerifier.verify`'s own reconstruction of
  the signed object (the `signed` map at `signed_route_directory.dart:151`),
  read directly to guarantee field-for-field, order-irrelevant (canonical
  JSON sorts keys, so construction order in code doesn't matter) parity.

### 4.4 Migration (`vpn-web`)

Additive only, per ADR-0001 precedent:

```sql
alter table nodes
  add column if not exists transport text,               -- 'vless-reality' | 'hysteria2'
  add column if not exists reality_public_key text,
  add column if not exists reality_short_id text,
  add column if not exists reality_fingerprint text,
  add column if not exists vless_flow text,
  add column if not exists hysteria2_obfs_type text,
  add column if not exists transport_port int,
  add column if not exists tls_server_name text;

create table if not exists route_directory_state (
  id boolean primary key default true,
  version bigint not null default 0,
  last_payload_hash text,
  constraint route_directory_state_singleton check (id)
);
insert into route_directory_state (id) values (true) on conflict do nothing;
```

### 4.5 Route wiring (`vpn-web`)

`functions/v1/routes.js`, `GET /v1/routes`, following `entitlement.js`'s
existing `withV1User`/`v1Json` pattern (an authenticated session is
required to fetch it, per the contract's own auth model — the directory
itself contains no per-user data, but the endpoint still lives under the
authenticated `/v1` surface the client already calls into). No admin
route, no manual trigger: the directory is computed fresh (or from cache,
see 4.3) on every request, since it reads live node/location state.

## 5. Testing

- `canonical-json.js`: sorts keys at every nesting depth, matches
  `tamara-next`'s documented output for the exact fixture values used in
  `signed_route_directory_test.dart` where reasonable to share.
- Route rendering (pure logic, extracted the same way `scheduler.js`
  separates pure selection from DB-facing wrappers): a `fast` route is
  produced only when a location has a capacity-eligible EXIT node; a
  `privacy_plus` route is produced only when both hops have a candidate,
  never half-populated; a node with no reported transport params is
  excluded; route ids are stable across a node swap for the same
  location.
- Signing: a `vpn-web`-side round trip — sign an envelope, verify its own
  signature and canonical-JSON reconstruction match — plus a fixed-vector
  test asserting the exact canonical JSON string for a known payload
  (catches any future accidental change to `canonical-json.js`'s output
  shape).
- `directory_version`: unchanged payload content across two calls reuses
  the same version; a changed payload (e.g. a node's `configured_users`
  changing which node `selectNodeForDevice` prefers) bumps it.
- Bootstrap reporting: `bootstrap-status.js` persists a well-formed
  `transport` object onto the right node row; malformed/partial transport
  data is rejected (fails that field, not the whole bootstrap report).

## 6. Open follow-ups (not blocking this increment)

- Key rotation tooling (issuing/retiring a `key_id`, documented runbook).
- Sub-project B: `POST /v1/vpn/authorize` per-connection credential
  issuance — its own design pass.
- Sub-project C: real interop testing against `tamara-next`'s built
  client.
- Hysteria2 hop rendering, once a real Hysteria2-primary node exists to
  validate against.
- A route id collision scheme (numeric suffix) if a future phase ever
  needs more than one route per `(location, mode)` pair.
