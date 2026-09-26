# ADR-0002: vpn-web's `/v1` backend adopts tamara-next's signed route directory + pseudonymous authorization contract

> Status: ACCEPTED. Decision made 2026-09-25; implementation not started by
> this ADR — see "Consequence" for what remains.

## Context

`vpn-web` and `tamara-next` (`David610/tamara-next`, the Arcana Flutter
client) evolved their client/server contract independently and diverged
on the most security-sensitive part of it: how a device gets authorized
to connect and which route/server it's told to use.

**`tamara-next`'s design** (real, already-merged code — not a sketch):
`docs/architecture/managed-client.md`, `docs/contracts/managed-control-plane-v1.md`,
`RouteDirectoryVerifier`, `CachingRouteDirectoryClient`,
`ManagedClientCoordinator`, `ManagedHomeScreen` in that repo. Contract:
- `GET /v1/routes` returns a **signed Ed25519 envelope** (`schema_version`,
  `directory_version`, `issued_at`, `expires_at`, `key_id`, `payload`,
  `signature`), verified client-side against app-pinned trusted keys.
  Monotonic version, rollback-refused, unknown keys fail closed.
- `POST /v1/vpn/authorize` with `{ route_id }` returns short-lived,
  per-connection, per-hop pseudonymous credentials — explicitly excluding
  account email, account id, billing/payment id, or subscription id.
- Documented explicitly as depending on a control plane "not implemented
  in this repository" — this was always meant to be built server-side.

**`vpn-web`'s actual backend** (verified by direct code reading — see
`functions/v1/*`, `functions/api/vpn/config.js`):
- `GET /api/vpn/config` returns a per-device `subscription_url` keyed to
  `vpn_user_id`, a pseudonymous identifier already separate from account
  email/payment — but longer-lived (revoked only via explicit device
  revoke, not short-lived/expiring per connection), unsigned, and with no
  versioned/rollback-protected directory concept.
- No `GET /v1/routes`, no `POST /v1/vpn/authorize`.
- Login/refresh/logout/entitlement request/response shapes already match
  `tamara-next`'s proposal almost exactly (`docs/contracts/managed-control-plane-v1.md`'s
  session model section) — that part of the contract was clearly
  coordinated at some point. The route/authorization layer was not.

This was discovered only because a routine `git push` was rejected:
`tamara-next`'s local checkout used for a prior nav-rebrand/contract-doc
pass (this repo's ADR-0001 companion work) was stale by ~80 commits,
including the entire managed-client layer above. That work has been
reset off `tamara-next`'s `main` (preserved on branch
`backup/stale-arcana-rebrand-2026-09-25` there) rather than merged over
real code — this ADR is what replaces it.

## Decision

**`vpn-web`'s `/v1` backend will be built out to match `tamara-next`'s
existing contract**: a signed, versioned, rollback-protected route
directory (`GET /v1/routes`) and short-lived pseudonymous per-connection
VPN authorization (`POST /v1/vpn/authorize`), per
`tamara-next/docs/contracts/managed-control-plane-v1.md` (treated as the
authoritative source for exact request/response shapes — this ADR does
not restate or fork them).

`GET /api/vpn/config`'s subscription-URL delivery is not deleted by this
decision — see Consequence.

## Why this direction, not the reverse

- **The client side is already built and tested against this contract.**
  Simplifying `tamara-next` down to `vpn-web`'s current model would mean
  deleting real, working privacy-hardening code (`RouteDirectoryVerifier`,
  signature/rollback checks, per-connection credential issuance) to match
  a simpler backend, rather than building the backend up to match
  already-validated client behavior.
- **Stronger security properties, not just different ones.** A static,
  longer-lived subscription URL is a real credential that's dangerous if
  it leaks and stays valid until someone notices and revokes the device.
  Short-lived per-connection authorization bounds that exposure window by
  design. A signed, rollback-protected directory prevents a compromised or
  malicious intermediary from serving a stale or forged route list —
  `GET /api/vpn/config` has no equivalent protection today.
- **Not net-new infrastructure invented for its own sake.** The route
  payload's actual content (per-hop `transport`/`server_address`/
  `server_port`/`tls_server_name`/REALITY fields, `failure_domain`,
  `mode: fast|privacy_plus` with hop-count invariants) maps directly onto
  data `vpn-web`'s fleet/scheduler already computes today — `nodes`,
  `NodeRole::Relay`/`Exit`, `allowed_paths`, `access_paths`, the
  `singbox-vpn` peer-credential/access-path model referenced in
  `singbox-vpn/docs/ADR/0009-declarative-peer-endpoints.md` and
  `0010-fleet-platform-foundations.md`. This is a new *delivery* format
  for route/credential data that is already computed, not a new source of
  truth. Ed25519 signing and directory versioning are the genuinely new
  pieces.
- Matches the brief's own "no overengineering" constraint in spirit: this
  is one clearly-scoped signing/versioning layer on top of existing fleet
  data, not a second control plane, not a new VPN protocol.

## Consequence

- `GET /api/vpn/config` (subscription-URL delivery) **stays** — it is the
  live mechanism for the existing web account setup-link flow
  (`/account/help/`, `AccountActionsCard`'s "Connect a device" instructions)
  and third-party sing-box-compatible clients (Hiddify, etc.) that only
  know how to consume a subscription URL, not this signed-directory
  protocol. The two delivery mechanisms coexist: subscription-URL for
  manual/third-party client setup, signed-directory + per-connection
  authorization for the first-party Arcana (tamara-next) app once built.
- Real, non-trivial new backend work is required and is **not done by
  this ADR**: Ed25519 key generation/storage/rotation policy, a
  `directory_version` monotonic counter and its persistence, `GET /v1/routes`
  rendering `allowed_paths`/node data into the documented payload shape,
  `POST /v1/vpn/authorize` issuing short-lived per-hop credentials (likely
  requiring new per-connection identity issuance in `singbox-vpn`'s
  provisioning-agent contract, not just a `vpn-web` change), and real
  interop testing against `tamara-next`'s already-built
  `RouteDirectoryVerifier`/`CachingRouteDirectoryClient`.
- `tamara-next`'s `main` is unchanged by this decision — its contract
  proposal is what `vpn-web` is now committing to build against, not
  something being revised.
- This is its own implementation project (design → schema/migration →
  signing infra → agent contract changes → client interop testing), sized
  similarly to the original fleet platform work (`vpn-web` ADR/plan
  precedent: `singbox-vpn/docs/ADR/0010-fleet-platform-foundations.md`).
  It should get its own ADR-companion implementation plan before code
  changes start, not be folded into unrelated work.

## Alternatives considered

- **Simplify `tamara-next` to match `vpn-web`'s subscription-URL model.**
  Rejected: discards real, tested security-hardening code for a strictly
  weaker credential-lifetime and directory-integrity model, to avoid
  backend work that is bounded and buildable on data the fleet already
  computes.
- **Leave both as-is, let them coexist indefinitely without a decision.**
  Rejected: `tamara-next`'s managed-client code (`ManagedClientCoordinator`
  et al.) is unreachable/dead in production without a real backend behind
  it — every managed-mode user state it defines (route loading, connecting,
  "unavailable control plane") has nothing to talk to. Leaving this
  undecided blocks any real progress on the first-party Arcana app.

## Status

Accepted. Implementation is tracked as its own project per Consequence
above, decomposed into three sub-projects:

- **A — Ed25519 signing infrastructure + `GET /v1/routes`: SHIPPED**
  (`docs/superpowers/specs/2026-09-26-adr0002-signed-route-directory-design.md`).
  vpn-web-only this pass — no `singbox-vpn`-side change generates real
  transport data yet (that piece needs a session with a Rust toolchain to
  compile-verify it; none was available here), so the directory correctly
  returns an empty `routes` array until a node actually reports one.
- **B — `POST /v1/vpn/authorize` (per-connection pseudonymous credential
  issuance): SHIPPED**
  (`docs/superpowers/specs/2026-09-26-adr0002-vpn-authorize-design.md`).
  Reuses each device's existing `vpn_accounts` identity per resolved hop;
  `expires_at` is a short advisory TTL on the response, not a real
  per-connection credential rotation yet (that needs a `singbox-vpn`
  change — Sub-project B2, not started, needs a Rust-toolchain session).
- **C — real interop testing against `tamara-next`'s built client: not
  started.**
