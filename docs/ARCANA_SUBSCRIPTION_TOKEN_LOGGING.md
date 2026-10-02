# Subscription bearer-token logging production gate

Subscription URLs contain a bearer secret in the path. Application code must
never log a request URL, pathname, token, `Referer`, or token hash. The gateway
already returns `Cache-Control: private, no-store`, `Referrer-Policy:
no-referrer`, and `X-Robots-Tag: noindex, nofollow, noarchive`; those controls
do not disable provider logs.

## Repository architecture

Serve `/sub/*` on a dedicated hostname (recommended:
`subscriptions.arcana.example`) with analytics, browser insights, tracing
payload capture, request-log export, and third-party scripts disabled. Keep
the customer site hostname separate. Do not add the subscription hostname to
general-purpose analytics or observability datasets. Error messages must use
request IDs generated independently of the URL.

## Required live Cloudflare verification (external production gate)

An operator with production Cloudflare access must complete and retain
screenshots/exports of every step before live qualification:

1. Confirm the dedicated hostname routes only `/sub/*` to this Pages project
   and redirects neither to nor from the customer-site hostname.
2. In **Web Analytics** and **Browser Insights**, verify the hostname is absent
   or both products are disabled for it.
3. In **Logs / Logpush**, inspect every enabled job and exclude the hostname.
   If exclusion is impossible, disable HTTP request fields containing URI,
   path, query, `Referer`, and headers. Confirm the destination has no legacy
   token-bearing events and apply its shortest supported retention.
4. Check Workers/Pages observability, invocation logs, Tail consumers, traces,
   exception capture, and third-party logging integrations. Disable request
   payload/header/URL capture for this hostname.
5. Check WAF/security-event exports. Configure redaction of URI path and query
   before export; IP addresses must use the approved retention/access policy.
6. Fetch a disposable test subscription. Search all Cloudflare dashboards and
   log destinations for the full token and unique path fragment. Both searches
   must return zero results. Revoke the disposable device immediately.
7. Verify the response has `no-store`, `no-referrer`, `noarchive`, and
   `nosniff`, and that no redirect or error response reflects the token.
8. Record zone/project IDs, settings, verifier, UTC timestamp, evidence links,
   and a scheduled quarterly re-verification in the security change ticket.

This checklist cannot be declared complete from repository CI. It requires
live Cloudflare credentials and provider-side inspection; no production change
or live verification was performed as part of the repository work.

## Authorization-v2 rollout order

Acknowledgement enforcement is intentionally controlled by
`EXTERNAL_AUTHORIZATION_ACK_MODE`. The only accepted values are `legacy` (the
default migration mode) and `enforce`; an unknown value fails subscription
publication closed. Roll out in this order:

1. Merge, release, and deploy the compatible `singbox-vpn` change first.
2. Verify every target node requests `?schema=2` and successfully ACKs the
   exact `snapshot_revision` it applied.
3. Deploy vpn-web with `EXTERNAL_AUTHORIZATION_ACK_MODE=legacy`; confirm node
   `applied_revision` catches up without changing subscription publication.
4. Set `EXTERNAL_AUTHORIZATION_ACK_MODE=enforce` only after that evidence is
   present. From then on, a target is publishable only when its required
   revision is proven applied.

Never enable enforcement before the compatible agent rollout. Existing rows
start pending by design; the explicit legacy stage prevents a fleet-wide 503
while preserving a deliberate, auditable switch to strict enforcement.
