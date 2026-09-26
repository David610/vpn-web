# Production configuration inventory

Every environment variable read by the web app (`src/`, Next.js static export)
and the Cloudflare Pages Functions (`functions/`), found by grepping
`env.X` / `process.env.X`. Keep this file, `.dev.vars.example` and
`CONFIG_VARIABLES` in `functions/lib/admin-fleet.js` in sync — the last one
drives the presence-only readiness list on **Admin → Settings** and
**Admin → Fleet → Flags & readiness** (values are never displayed).

**Type**

- **build-time** — `NEXT_PUBLIC_*`, inlined into the static bundle at `next build`. Public by definition; never put a secret here.
- **runtime** — plain Cloudflare Pages Functions variable (not secret).
- **secret** — Cloudflare Pages *encrypted* secret (`wrangler pages secret put` / dashboard "Encrypt").

**Owner** is the system the value comes from / is managed in. Stripe is in
**test mode** for now: all Stripe values are `sk_test_…` / test price ids
until launch. The node DNS zone is `sustechnologies.eu` on Cloudflare DNS.

Product model note: one person per account; an account may hold several
subscriptions; each subscription covers 3 devices and can add +3-device
packs; devices can be moved between the account's subscriptions. Some names
(e.g. `STRIPE_SEAT_PRICE_ID`) are legacy and keep the old "seat" wording.

## Web build (Cloudflare Pages build settings)

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | build-time | Supabase | Supabase project URL for the browser client (`src/lib/supabase.ts`) | TBD |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build-time | Supabase | Public anon key for the browser client (RLS-restricted) | TBD |
| `NEXT_PUBLIC_SITE_URL` | build-time | Cloudflare Pages | Canonical site URL for metadata/links (`src/lib/site-config.ts`) | TBD |
| `NODE_ENV` | build-time | Cloudflare Pages | Set automatically by Next.js; not configured by hand | n/a |

## Core runtime (Pages Functions)

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `SUPABASE_URL` | runtime | Supabase | Supabase project URL for every server call | TBD |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Supabase | Service-role access used by all Functions (bypasses RLS) | TBD |
| `SUPABASE_ANON_KEY` | runtime | Supabase | GoTrue calls from `functions/lib/gotrue.js` (falls back to service role) | TBD |
| `SITE_URL` | runtime | Cloudflare Pages | Absolute URLs in emails, Stripe success/cancel redirects | TBD |
| `VPN_SECRETS_ENCRYPTION_KEY` | secret | Cloudflare Pages | 32-byte hex key encrypting VPN credentials at rest | TBD |

## Billing — Stripe (test mode for now)

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `STRIPE_API_KEY` | secret | Stripe (test mode) | Checkout, billing portal, subscription updates | TBD |
| `STRIPE_SIGNING_SECRET` | secret | Stripe (test mode) | Verifies `/api/stripe/webhook` signatures (`whsec_…`) | TBD |
| `STRIPE_PRICE_ID` | runtime | Stripe (test mode) | Base subscription price (includes 3 devices) | TBD |
| `STRIPE_SEAT_PRICE_ID` | runtime | Stripe (test mode) | +3-device pack price, per subscription (legacy "seat" name) | TBD |

## Messaging

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `RESEND_API_KEY` | secret | Resend | Transactional and alert email | TBD |
| `ALERT_FROM_EMAIL` | runtime | Resend | From address (default `onboarding@resend.dev`; needs a verified domain in prod) | TBD |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram | Account linking + Mini App `initData` HMAC; Telegram auth fails closed without it | TBD |

## Fleet provisioning

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `HETZNER_API_TOKEN` | secret | Hetzner | Create/delete node servers | TBD |
| `FLEET_HETZNER_SERVER_TYPE` | runtime | Hetzner | Optional server type override | TBD |
| `FLEET_HETZNER_IMAGE` | runtime | Hetzner | Optional image override | TBD |
| `FLEET_DNS_PROVIDER` | runtime | Cloudflare DNS | DNS adapter name (default `cloudflare`) | TBD |
| `CLOUDFLARE_DNS_API_TOKEN` | secret | Cloudflare DNS | Zone.DNS:Edit token scoped to `sustechnologies.eu` only (never the deploy token) | TBD |
| `CLOUDFLARE_DNS_ZONE_ID` | runtime | Cloudflare DNS | Zone id of `sustechnologies.eu` | TBD |
| `FLEET_DNS_ZONE` | runtime | Cloudflare DNS | Human-readable zone name (`sustechnologies.eu`). Documentation/ops reference; not currently read by code — the code uses `CLOUDFLARE_DNS_ZONE_ID` + `FLEET_NODE_DOMAIN` | TBD |
| `FLEET_NODE_DOMAIN` | runtime | Cloudflare DNS | Node hostnames are `<nodeId>.<FLEET_NODE_DOMAIN>` (a name under `sustechnologies.eu`) | TBD |
| `FLEET_SINGBOX_VPN_VERSION` | runtime | singbox-vpn release | Pinned release tag every new node installs | TBD |
| `FLEET_SINGBOX_VPN_REPO` | runtime | singbox-vpn release | Optional release repository override | TBD |
| `FLEET_REALITY_HANDSHAKE_SERVER` | runtime | Cloudflare Pages | REALITY camouflage handshake target (SNI) for new nodes; provider-backed create/replace refuse without it | TBD |
| `FLEET_TICK_SECRET` | secret | Supabase | Shared secret the pg_cron reconciler presents to `/api/internal/fleet-tick` (also stored in Supabase Vault) | TBD |

## Route signing

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `ROUTE_SIGNING_PRIVATE_KEY` | secret | Cloudflare Pages | Private key signing the `/v1/routes` directory | TBD |
| `ROUTE_SIGNING_KEY_ID` | runtime | Cloudflare Pages | Key id clients pin to verify the signature | TBD |

## Fleet automation feature flags

All default off; `"true"` enables.

| Variable | Type | Owner | Purpose | Configured in production |
|---|---|---|---|---|
| `FEATURE_MULTI_NODE_SCHEDULING` | runtime | Cloudflare Pages | Scheduler places devices across multiple nodes | TBD |
| `FEATURE_AUTO_NODE_HEALTH` | runtime | Cloudflare Pages | Probe/silence-driven lifecycle transitions | TBD |
| `FEATURE_AUTO_NODE_REPLACE` | runtime | Cloudflare Pages | Automatically replace long-FAILED nodes | TBD |
| `FEATURE_AUTO_NODE_REPLACE_CANARY` | runtime | Cloudflare Pages | Automatic replacements go through CANARY | TBD |
| `FEATURE_AUTO_NODE_SCALE` | runtime | Cloudflare Pages | Add nodes to locations near capacity | TBD |
| `AUTO_REPLACE_AFTER_FAILED_MS` | runtime | Cloudflare Pages | How long a node stays FAILED before auto-replace | TBD |
| `FLEET_AUTO_REPLACE_REGION` | runtime | Hetzner | Provider region used by auto-replace | TBD |
| `FLEET_AUTO_SCALE_REGION` | runtime | Hetzner | Provider region used by auto-scale | TBD |
