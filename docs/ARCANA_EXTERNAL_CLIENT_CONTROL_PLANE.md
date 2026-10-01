# Arcana external-client control-plane contract

## Security boundary

```text
ACCOUNT PLANE
Supabase / Stripe / seats
          |
          v
external device
account_id <-> ext_principal
          |
          | identity boundary
          v
ROUTING/AUTH PLANE
ext_principal
credential IDs
logical route
validity
          |
          v
NODE
opaque authorization only
```

Arcana is **not anonymous**. The account plane necessarily links an account to
the stable external principal so customers can manage seats and revoke devices.
The node projection deliberately contains no account, Supabase user, email,
Stripe, device-name, or subscription-token field.

Account authentication, the per-device subscription bearer token, and VPN
protocol secrets are independent. A device gets a cryptographically random
stable `ext_` principal. Every VPN generation gets a fresh `cred_` identifier
and fresh VLESS/Hysteria2 material. The subscription token has 256 random bits,
is returned only when issued, and only a keyed HMAC-SHA-256 lookup is stored.

## Credential policy and rotation

Compatibility generations live seven days. Rotation publishes B immediately
and bounds A to a 48-hour overlap. This accommodates normal mobile/laptop sleep
without using the data plane's maximum permitted lifetime. Database locking and
the two-live-generation trigger prevent A/B/C overlap. Subscription-token
rotation changes only the bearer token; VPN credential rotation changes only
VPN material. Device revocation invalidates the bearer hash, marks both A and B
revoked, projects urgent fail-closed state, and releases the seat atomically.

Native Arcana remains on the lease-pool authorization path: its renewal target
is 30 minutes and renewal extends the same lease/slot secrets. A client should
renew with jitter roughly 10–15 minutes before expiry; the server expiry is
authoritative and an authorization horizon is not a forced connection length.

## Client capability matrix

| Client | Fast VLESS+REALITY | Fast Hysteria2 | Privacy+ |
|---|---:|---:|---:|
| Hiddify | yes | emitted, qualification pending | unsupported |
| Shadowrocket | yes | emitted, qualification pending | unsupported |
| INCY | yes | no | unsupported |
| generic sing-box | yes | yes | unsupported pending pinned nested-config validation |
| generic Xray | yes | no | unsupported |

An unsupported mode produces an explicit `unsupported_client_mode` response.
It never renders Fast. Logical route IDs represent region and privacy class;
the current node target is resolved at fetch time. Display labels never use an
internal node ID, although protocol configs necessarily contain a public
hostname/IP.

## Subscription delivery and privacy

Responses require HTTPS and use `private, no-store`, `Pragma: no-cache`,
`X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`,
and `nosniff`. Rate-limit keys use token/IP HMACs, not plaintext. Only the most
recent fetch timestamp is kept; no request URL, destination, DNS query, packet,
or browsing history is collected.

A copied URL can be cloned. Arcana intentionally does not add persistent HWID
fingerprinting: one token represents one purchased device seat, and rotation
and revocation are the recovery controls.

Cloudflare request-log configuration is outside this repository. A path bearer
token can be present in provider request logs even though application code never
logs it. Production must not be enabled until the subscription hostname/route
has verified log redaction or logging disabled and analytics/error tooling is
verified not to capture URLs.

## Production qualification still required

Before deployment, validate every emitted fixture against the reviewed
`singbox-vpn` head and real target clients; qualify Hysteria2 imports/refresh;
implement and validate make-before-break logical-route target migration;
exercise node-apply/DB-failure recovery; run migration race/RLS tests against
Postgres; verify retention cron and historical plaintext URL purge; and verify
Cloudflare log redaction. These are operational/cross-repository gates, not
claims satisfied by repository code alone.

