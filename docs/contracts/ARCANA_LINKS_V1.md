# Arcana Links API v1

**Status:** stable native/mobile contract  
**Base URL:** the Arcana customer control-plane origin  
**Media type:** `application/json` except successful deletes, which have no body

This is the authoritative contract for native clients. Native clients must not call the browser-only `/api/account/*` surface.

## Authentication and transport

Every endpoint requires `Authorization: Bearer <access-token>`. Responses carry `Cache-Control: no-store`. An absent, invalid, or expired session returns `401` and `{"message":"Please log in again."}`. TLS is required in production. Link and client identifiers are UUIDs; malformed identifiers return `400 invalid_id`. Missing, revoked where active state is required, foreign, and incorrectly nested resources are intentionally indistinguishable (`404`) to prevent enumeration.

The only supported configuration family in this API is `compatibility`. Link-created external clients have the server-selected type `links`; callers cannot submit a client type.

## Resource representations

A Link contains exactly:

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID string | Stable Link identifier. |
| `name` | string | Customer name, 1–80 allowed characters. |
| `status` | `active` or `revoked` | Lifecycle state. |
| `route_id` | string | Stable selection/reference identifier. |
| `route_label` | string | Friendly label from canonical logical-route metadata. |
| `configuration_family` | `compatibility` | Configuration family. |
| `active_clients` | integer | Current non-revoked children. |
| `max_clients` | integer | Link-local ceiling, 1–100. |
| `created_at` | ISO-8601 string | Creation instant. |
| `revoked_at` | ISO-8601 string or null | Revocation instant. |

A client contains exactly `id`, `name`, `status`, `client_type`, `created_at`, `last_seen_at`, and `revoked_at`. `last_seen_at` is the last subscription fetch time or `null`; the API does not invent usage.

## Endpoints

### `GET /v1/links`

Returns `200 {"links":[Link, ...]}` in creation order. It never returns credentials.

### `POST /v1/links`

Exact body:

```json
{"name":"Travel","route_id":"route_de_fast","max_clients":3}
```

Unknown fields are ignored. The three documented fields are required and validated. Returns `201 {"link": Link}`. The server proves that the canonical route exists, is enabled, and supports canonical client type `links`; an unavailable or incompatible route returns `422 unsupported_route`. This is enforced server-side for both v1 and browser creation.

### `GET /v1/links/:id`

Returns `200 {"link": Link, "clients":[Client, ...]}`. A foreign or missing Link returns `404 link_not_found`.

### `POST /v1/links/:id/clients`

Requires an `Idempotency-Key` header of 16–200 characters. Exact body:

```json
{"name":"Laptop","subscription_id":"123"}
```

`subscription_id` is a 1–18 digit string and must belong to the authenticated account with usable entitlement. The server selects `client_type: "links"`. Creation atomically consumes canonical subscription/device capacity and Link capacity through the existing database function.

A fresh result is `201`:

```json
{
  "client":{"id":"22222222-2222-4222-8222-222222222222","name":"Laptop","status":"active","client_type":"links","created_at":"2026-10-03T12:01:00Z","last_seen_at":null,"revoked_at":null},
  "replayed":false,
  "configuration_url":"https://vpn.example/sub/REDACTED",
  "shown_once":true
}
```

The configuration URL is secret-bearing and is delivered once. A response-loss retry with the same key and operation returns `200` with the original normalized client and `replayed: true`, and **does not** contain a URL, token, credential, `shown_once`, or newly generated usable secret. Concurrent identical requests serialize to one client and at most one secret-bearing response. A key reused for a different operation returns `409 idempotency_conflict`. Capacity failures return `409 capacity_exhausted`.

### `POST /v1/links/:linkId/clients/:clientId/replace-link`

No request body. Returns `200` with `client`, a fresh `configuration_url`, and `shown_once: true`. This rotates only the external subscription bearer token. It does not rotate VLESS/Hysteria protocol credentials. The old URL fails token lookup immediately and cannot be revealed again. The caller must prove ownership of both resources and `client.account_id == authenticated account` **and** `client.link_id == :linkId`; a same-account client under another Link returns `404 client_not_found`.

### `DELETE /v1/links/:linkId/clients/:clientId`

Returns `204` with no body. It revokes only the correctly nested client and its existing external-device lifecycle. Ownership and nesting checks are identical to replacement.

### `DELETE /v1/links/:id`

Returns `204` with no body. The transaction-safe existing Link revocation function revokes the Link and all active child clients. Later active mutations return `404 link_not_found`.

## Route compatibility

Compatibility comes exclusively from `functions/lib/client-capabilities.js`; there is no second support list. At publication time canonical type `links` supports only `fast` routes. `privacy_plus` is fail-closed with `422 unsupported_route`. Browser route choices are generated from that same capability table. This contract makes no assertion of two-server support.

This is permanent for `links`, `hiddify`, `shadowrocket` and `incy`, not a pending qualification: their formats are bare connection URIs (`vless://`, `hysteria2://`), a single-endpoint shape with no field that can express a second hop. `xray`'s format is a thin wrapper around the same bare URIs and has the same limit.

`singbox`'s format (a real sing-box JSON config) expresses `privacy_plus` via sing-box's own `detour` outbound-chaining — the same mechanism `singbox-vpn`'s own, separate renderer already proves end-to-end against a real sing-box binary over real two-provider infrastructure. `functions/lib/subscription-renderers.js`'s `renderSingBox` now builds this correctly, and the per-hop credential model it needs (an independently-scoped credential per hop, per `ARCANA_PRODUCT_V1.md` §4b, not one credential shared across both) now exists end-to-end: `compatibility_credentials.hop`, and `create_external_vpn_device`/`rotate_compatibility_credential` both take a `p_credentials` array (one element per hop) that's authorized only against its own hop's node — see `supabase/migrations/20261016000000_compatibility_two_hop_credentials.sql`. Covered by SQL tests (`supabase/tests/external_device_lifecycle_test.sql`) and unit tests (`compatibility-publication.test.js`, `subscription-renderers.test.js`, `external-credentials.test.js`).

The capability table still refuses `privacy_plus` for `singbox` regardless: this is a deliberate, separate decision from "is the code correct," not a leftover gap — nothing has yet verified a real sing-box-based compatibility client actually honors the rendered `detour` chain against this pipeline's real, deployed node infrastructure (as opposed to `singbox-vpn`'s own proven, but separate, implementation). Flipping it is its own explicit follow-up once that verification exists, not a side effect of this one.

## Errors

Errors use `{"error":"user-safe text","code":"stable_code"}` after successful authentication. Authentication retains the shared v1 shape described above.

| HTTP | Stable code | Meaning |
|---:|---|---|
| 400 | `invalid_request` | Malformed JSON/body or invalid fields. |
| 400 | `invalid_id` | Malformed Link/client UUID. |
| 400 | `invalid_idempotency_key` | Missing or invalid idempotency header. |
| 401 | absent | Invalid/expired authentication; sign in again. |
| 403 | existing v1 auth/recent-auth code | Reserved for an applicable authenticated security gate. |
| 404 | `link_not_found` | Link missing, foreign, revoked for mutation, or concealed. |
| 404 | `client_not_found` | Client missing, foreign, revoked, or under the wrong Link. |
| 404 | `subscription_not_found` | Subscription is missing, foreign, or not entitled. |
| 409 | `capacity_exhausted` | Link or canonical device-seat capacity is exhausted. |
| 409 | `idempotency_conflict` | Key was used for a different operation. |
| 422 | `unsupported_route` | Route is absent, disabled, or incompatible with `links`. |
| 503 | absent | Temporary database/control-plane failure: `{"message":"Arcana is temporarily unavailable."}`. |

Common fixtures:

```json
{"error":"No client capacity is available","code":"capacity_exhausted"}
```

```json
{"error":"Route is unsupported for compatible Link clients","code":"unsupported_route"}
```

```json
{"error":"Client not found","code":"client_not_found"}
```

```json
{"message":"Please log in again."}
```

## Copy-pastable non-secret fixtures

List:

```json
{"links":[{"id":"11111111-1111-4111-8111-111111111111","name":"Travel","status":"active","route_id":"route_de_fast","route_label":"Germany","configuration_family":"compatibility","active_clients":1,"max_clients":3,"created_at":"2026-10-03T12:00:00Z","revoked_at":null}]}
```

Empty list:

```json
{"links":[]}
```

Create:

```json
{"link":{"id":"11111111-1111-4111-8111-111111111111","name":"Travel","status":"active","route_id":"route_de_fast","route_label":"Germany","configuration_family":"compatibility","active_clients":0,"max_clients":3,"created_at":"2026-10-03T12:00:00Z","revoked_at":null}}
```

Detail:

```json
{"link":{"id":"11111111-1111-4111-8111-111111111111","name":"Travel","status":"active","route_id":"route_de_fast","route_label":"Germany","configuration_family":"compatibility","active_clients":1,"max_clients":3,"created_at":"2026-10-03T12:00:00Z","revoked_at":null},"clients":[{"id":"22222222-2222-4222-8222-222222222222","name":"Laptop","status":"active","client_type":"links","created_at":"2026-10-03T12:01:00Z","last_seen_at":null,"revoked_at":null}]}
```

Fresh issuance (the placeholder is deliberately not usable):

```json
{"client":{"id":"22222222-2222-4222-8222-222222222222","name":"Laptop","status":"active","client_type":"links","created_at":"2026-10-03T12:01:00Z","last_seen_at":null,"revoked_at":null},"replayed":false,"configuration_url":"https://vpn.example/sub/REDACTED","shown_once":true}
```

Replay:

```json
{"client":{"id":"22222222-2222-4222-8222-222222222222","name":"Laptop","status":"active","client_type":"links","created_at":"2026-10-03T12:01:00Z","last_seen_at":null,"revoked_at":null},"replayed":true}
```

Replace-link (the placeholder is deliberately not usable):

```json
{"client":{"id":"22222222-2222-4222-8222-222222222222","name":"Laptop","status":"active","client_type":"links","created_at":"2026-10-03T12:01:00Z","last_seen_at":null,"revoked_at":null},"configuration_url":"https://vpn.example/sub/REDACTED","shown_once":true}
```

## Capacity, secrets, revocation, and privacy invariants

* `max_clients` is a Link-local ceiling, while subscription/device entitlement remains the canonical account capacity. Client creation is transaction-safe in the existing SQL function; API prechecks are not relied on for allocation.
* Protocol credentials remain independent per external device. Access-link replacement changes only the subscription bearer-token hash.
* Normal list/detail/create-Link/delete responses never include subscription tokens or hashes, credential ciphertext/nonces, protocol UUIDs/passwords/private material, authorization snapshots, or node IDs.
* Fresh client issuance and explicit replacement are the only endpoints that disclose a configuration URL. The web UI stores it only in component memory, tells the customer it is shown once, and clears it on navigation/unmount.
* Revoking one client does not revoke siblings. Revoking a Link revokes all active children. Revocation is not a secret-recovery mechanism.
* No endpoint collects or returns visited URLs, DNS history, destination IP history, flows, payloads, or browsing history. Usage remains aggregate-only elsewhere. This API reports no fabricated per-client usage value.
