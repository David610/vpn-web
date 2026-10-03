# Arcana Links and Clients

Status: Phase 1 control-plane foundation (2026-10-03)

## What existed before this phase

The external VPN gateway introduced in PRs #61–#63 already supplied most of
the security-critical client machinery. `external_vpn_devices` is a
seat-bearing extension of `devices`; every row has a pseudonymous principal,
a hashed subscription bearer token, and its own rows in
`compatibility_credentials`. Encrypted VLESS/Hysteria2 material is projected
to the relevant nodes through `compatibility_authorizations`. Logical routes
describe a fast (one-hop) or Privacy+ (two-hop) route and the renderer rejects
client formats which cannot safely represent the selected mode.

Creation is serialized on the subscription and creates the base device,
external-device extension, first credential, and node projections in one
transaction. Revocation atomically revokes only that device, burns its
subscription token, releases its device seat, and marks every projection
revoked. Rotation supports two bounded generations for make-before-break.
Node snapshots have per-node monotonic revisions and exact acknowledgements,
including revision-zero/empty snapshots. Those mechanisms are reused, not
reimplemented.

Thus the old external device already approximated a **Link Client**, not a
Link. It did not share credentials: one external device owned one independent
credential lineage. No customer policy/container grouped several clients.
The Phase 1 delta adds that missing parent.

## Model

```text
customer_account
  -> vpn_link (name, route, family, client limit; zero seats)
       -> external_vpn_device (one existing device seat)
            -> compatibility_credentials (independent generations)
            -> compatibility_authorizations (opaque node projection)
```

A Link is not a credential. It is a named policy container. Sharing one
private credential among unrelated installations would make individual
revocation, rotation, usage attribution, and entitlement accounting
impossible. Existing unlinked external devices remain valid for compatibility;
they can be adopted by a future explicit migration rather than guessed into a
Link.

`configuration_family` is deliberately limited to `compatibility`. Current
production code renders VLESS/Hysteria2 subscriptions for Hiddify,
Shadowrocket, Incy, sing-box, Xray, and raw links. There is no WireGuard
control/data-plane implementation in this repository, so Phase 1 does not
mislabel those credentials as WireGuard or invent an unsafe private-key store.

## Capacity and concurrency

Creating a Link inserts no `devices` row and consumes zero capacity. Adding a
client calls the existing `create_external_vpn_device()` transaction, so the
external client is exactly one canonical device capacity unit. That function
retains the existing subscription advisory lock and commercial `3 + paid
packs of 3` behavior. `device_entitlement()` remains the canonical issuance
decision used by ordinary device configuration paths; this phase adds no
JavaScript capacity formula.

The Link row is locked while enforcing `max_clients`, while the existing
subscription lock serializes account capacity. A keyed retry is HMACed before
storage and the `(link_id, idempotency_key)` uniqueness rule makes it return
the original client rather than allocate another seat. Revoked clients stop
counting and release their existing device seat. An unusual manually edited
`extra_seats` value is still interpreted by the pre-existing external-device
RPC; Phase 1 intentionally does not introduce a third rule to “correct” it.

## Credential lifecycle and delivery

1. **Issue:** client creation generates a unique opaque principal, credential
   identifier, encrypted VLESS/Hysteria2 material, and bearer token. Only the
   explicit mutation returns the configuration URL, once.
2. **Active:** normal Link/client GETs select an allow-list of public fields.
   They never select token hashes, ciphertext, nonces, or rendered configs.
3. **Replace:** the existing credential endpoint creates a new generation and
   bounds the old generation to the configured overlap. The trigger records
   its generation and `rotated_from` lineage. Node acknowledgement remains the
   proof that the new snapshot was applied. The old generation is not
   repeatedly revealed.
4. **Revoke client:** existing revocation invalidates only that client.
5. **Revoke Link:** one database transaction marks the Link revoked and invokes
   existing client revocation for every active child. Snapshot triggers make
   removals visible to nodes, including an empty authorization set.

Encrypted secret material remains only in the existing credential and opaque
node-projection tables. Audit, usage, API logs, and ordinary responses contain
identifiers/actions only.

## Routes

The Link references the existing logical route directory. `fast` routes are
one-hop. `privacy_plus` routes use the existing two-hop topology and sing-box
renderer, which automatically supplies the entry detour and explicit exit.
Formats unable to encode a mode fail closed. Route changes for an active Link
are intentionally not exposed in Phase 1 because safely reprojecting every
credential requires an acknowledged, make-before-break data-plane operation.

## Usage and privacy

`vpn_link_usage_daily` is a service-role-only daily aggregate keyed by account,
Link, client, and date. It can hold RX/TX bytes, optional connection count, and
a coarse last-seen bucket. A composite foreign key requires the client to
belong to both the recorded account and the recorded Link, preventing
cross-account or cross-Link attribution. It has no free-form metadata or columns for URL, domain, DNS
query, destination address, payload, browsing history, or search terms.

The existing node traffic endpoint reports node-wide totals only; official
sing-box currently provides no trustworthy per-user counter. Therefore this
phase creates the safe storage/read contract but does **not** fabricate Link
usage or copy node totals onto customers. Ingestion stays disabled until the
data plane can provide authenticated pseudonymous per-credential aggregates.

## HTTP and authorization boundary

Customer APIs live under the existing `/api/account` convention:

- `GET/POST /api/account/links`
- `GET/PATCH/DELETE /api/account/links/:id`
- `GET/POST /api/account/links/:id/clients`
- `GET /api/account/links/:id/usage`
- `GET /api/account/links/usage`

Existing external-device credential, token-replacement, and revoke mutations
remain the single implementation for client lifecycle. All handlers resolve
the authenticated user's account and filter by it. Tables have RLS enabled,
are revoked from `anon`/`authenticated`, and are reached by the service role
only through the authenticated API. Mutating RPCs are also service-role-only.

## Control-plane/data-plane contract (`singbox-vpn`)

The node must treat `principal_id` and `credential_id` as pseudonymous opaque
identifiers. It fetches the complete authorization snapshot for its node,
applies exactly the supplied encrypted/decrypted protocol material and validity
window, then acknowledges the exact snapshot revision. Operations are
idempotent by `(node_id, credential_id, revision)`. A stale/future ACK must not
advance state. A revoked or absent credential must be removed; an empty
snapshot must remove all compatibility credentials. Rotation is
make-before-break: install and ACK the new generation before the bounded old
generation expires. Link revocation is represented as revocation/removal of
every child credential, not as a new node-side Link concept.

Phase 2 data-plane work: prove the current agent consumes and acknowledges
authorization snapshots; add pseudonymous per-credential cumulative RX/TX and
optional connection counters without destinations; sign/authenticate reports;
make retries monotonic/idempotent; and echo provisioning `claim_token` before
`REQUIRE_CLAIM_TOKEN=true` is enabled.

## `tamara-next` integration

The client app should list Link metadata and clients through normal GETs, use
an unpredictable `Idempotency-Key` for add-client retries, display the
configuration URL only from a successful fresh issuance/token replacement,
and label recovery as **Replace configuration**. It must never persist old
private configuration in analytics or logs and must not infer entitlement
from UI counts. WireGuard UI remains gated until a real end-to-end family is
implemented.

## Admin boundary and unresolved decisions

Admin APIs currently share the web origin. They authenticate a Supabase bearer
session, require an `admin_users` role and AAL2, use a separate browser storage
key, and have a strict `/admin` CSP. Mutations are audited, but not every audit
write is in the same transaction as its mutation. A future
`admin.<production-domain>` deployment needs separate hosting/routing,
admin-only cookies/storage and CORS allow-list, an admin CSP, CSRF/origin
policy, separate observability, and transactional audited Link operations.
Admins must never receive credential material from list/detail screens.

Still unresolved: a real WireGuard credential/provisioning design; safe live
route migration; the source and trust model for per-credential counters; usage
retention; migration UX for legacy unlinked external devices; and whether the
48-hour replacement overlap should become acknowledgement-driven with an
earlier cutover.
