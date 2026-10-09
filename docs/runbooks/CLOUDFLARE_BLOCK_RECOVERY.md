# Cloudflare Pages block: recovery and split deployment

Status 2026-10-09. Cloudflare refuses new deployments to the Pages project
`arcana-web-qual` with `Your Pages project has been blocked. Contact
abusereply@cloudflare.com [code: 8000119]`.

## What is known and what is not

Verified:

- The account is a normal free account. All four Pages projects exist and every
  `*.pages.dev` site still answers HTTP 200. This is not a plan, billing or quota limit.
- Only the create-deployment call fails. Uploading files succeeds. It is a
  trust-and-safety block on the project.
- Only Cloudflare can lift it.

Not verified: the trigger. Cloudflare did not say. The likeliest cause is that
the Functions bundle renders VPN client configurations (`/sub/<token>` serves
`vless://` and `hysteria2://` links, plus node bootstrap and agent endpoints:
32 source files mention VLESS, Hysteria2, sing-box or REALITY), which automated
checks may treat as a proxy service. Check the account email and the dashboard
banner for the stated reason before relying on this.

## Plan

1. **Appeal** (you send it; text below). This is the only step that unblocks the project.
2. **Split deployment** so Cloudflare serves only the static website and the
   VPN-delivering code runs on infrastructure you control. Implemented in this
   repository, not yet rolled out:
   - `server/` runs the existing `functions/**` handlers unchanged on Node 22.
   - `NEXT_PUBLIC_API_BASE_URL` makes the site call that API instead of same-origin.
   - `npm run stage-static-site` produces `dist-static/site`: HTML/JS/CSS only, no
     Functions bundle, and it fails if a `vless://`/`hysteria2://` string is present.
3. **Roll out** in the order below, with the old setup left running until the
   new one is verified.

Do not create a new Pages project or move the same code to another Cloudflare
account to get around the block; that can be treated as evasion and put the
whole account at risk.

## Architecture after the split

```
browser / Telegram Mini App ──► static site (Cloudflare Pages or any static host)
        │  Authorization: Bearer <Supabase JWT>  /  X-Telegram-Init-Data
        ▼
https://api.<your-domain>  (Caddy ─► Node server ─► functions/**)  ──► Supabase
        ▲                                   ▲
   VPN clients: /sub/<token>          Stripe webhook, node agents, cron ticks
```

Security properties of `server/`:

- `CF-Connecting-IP` and `X-Forwarded-For` from the client are discarded. The rate
  limiter uses the address the trusted proxy appended (`TRUSTED_PROXY_HOPS=1`
  behind the bundled Caddy, which overwrites `X-Forwarded-For`). Without a proxy
  leave it at `0` and the socket address is used.
- CORS is limited to `CORS_ALLOWED_ORIGINS` and only for `/api/*`. Auth is by
  bearer token, so no cookies cross origins.
- Request bodies over 1 MiB are refused. Handler errors return a generic 500.
- The container runs as a non-root user with a read-only filesystem and no capabilities.

## Rollout

Needs from you: a server (see cost), a hostname for the API (for example
`api.<domain>`) pointing at it, and the secrets listed below.

Cost to flag: a small VPS (about 4-5 EUR/month on Hetzner CX22) or an EC2
`t3.micro` (about 8-10 USD/month, free-tier eligible for the first year on new
accounts). Caddy obtains the TLS certificate for free. Supabase and Stripe costs are unchanged.

1. **Server.** Install Docker. Create `/etc/arcana/api.env` (mode 600, never in git):

   ```
   SUPABASE_URL=  SUPABASE_SERVICE_ROLE_KEY=  SUPABASE_ANON_KEY=
   SUBSCRIPTION_TOKEN_HASH_KEY=  VPN_SECRETS_ENCRYPTION_KEY=
   SITE_URL=https://<website-origin>
   PUBLIC_API_ORIGIN=https://api.<domain>
   CORS_ALLOWED_ORIGINS=https://<website-origin>
   STRIPE_API_KEY=  STRIPE_SIGNING_SECRET=  STRIPE_PRICE_ID=  STRIPE_SEAT_PRICE_ID=
   TELEGRAM_BOT_TOKEN=  RESEND_API_KEY=  FLEET_TICK_SECRET=  RETENTION_TICK_SECRET=
   ```

   Copy the remaining values (`FLEET_*`, `HETZNER_API_TOKEN`, `CLOUDFLARE_DNS_*`,
   `ROUTE_SIGNING_*`, `FEATURE_*`, `ALERT_*`) from the current Pages project's
   environment. Reuse the existing `SUBSCRIPTION_TOKEN_HASH_KEY` and
   `VPN_SECRETS_ENCRYPTION_KEY` values: new ones would invalidate every issued link.

2. **Start.**
   `API_DOMAIN=api.<domain> docker compose -f deploy/api/docker-compose.yml up -d --build`
   then `curl -fsS https://api.<domain>/healthz`.
3. **Build the site** with `NEXT_PUBLIC_API_BASE_URL=https://api.<domain>` (plus the
   usual Supabase and site URL values), then `npm run stage-static-site`.
4. **Verify before cutover**, against the new API with test data prefixed `qual-`:
   sign in, create a link, copy it, request it from `/sub/`, replace, revoke.
5. **Cut over, in this order:**
   1. Stripe dashboard: point the webhook destination to `https://api.<domain>/api/stripe-webhook`
      (use the signing secret of that destination in `STRIPE_SIGNING_SECRET`).
   2. Cron ticks: rerun `scripts/setup-fleet-cron.mjs` and `scripts/setup-retention-cron.mjs`
      with `SITE_URL=https://api.<domain>` (they POST to `<SITE_URL>/api/internal/*-tick`).
   3. Node agents: nodes created after the cutover get `PUBLIC_API_ORIGIN` as their
      `worker_url` automatically. Existing nodes have the old Pages host baked into
      their agent configuration (`worker_url`), so either change it on each node and
      restart the agent, or keep the old host serving `/api/agent/*` until you have.
      I have not tested an agent against the new host.
   4. Deploy the static site: `cd dist-static && npx wrangler pages deploy site --project-name <project> --branch main`
      (needs the Cloudflare block lifted, or another static host).
   5. Telegram: the Mini App URL stays the website origin, so no change.
6. **Existing links** keep working only while the host in them answers. Links issued
   earlier point at the old Pages host. Keep that project serving `/sub/*` until
   the appeal is resolved, or accept re-issuing links (each customer copies the new one).

Rollback: switch the Stripe webhook and cron URLs back, and redeploy the previous
site build. Nothing in the database changes with this split.

## Verified in this repository

- `server/__tests__`: routing precedence on the real `functions/` tree, spoofed-IP
  handling, CORS, 405/404/500 behaviour (18 tests).
- `scripts/__tests__/csp-api-origin.test.mjs`: the CSP gains only the API origin.
- End-to-end with the site and API on different origins, real browser, real
  Supabase and Postgres: portal 37/37, Telegram 44/44, admin 28/28
  (`E2E_API_BASE=http://127.0.0.1:8787 node scripts/e2e/portal.mjs`, same for the others).
- The Docker image builds, runs hardened as above and reports healthy.

Not verified: a real server and domain, real TLS, Stripe webhook delivery to the
new host, node agents calling the new URL, and any actual VPN tunnel.

## Draft appeal (send from the account email to abusereply@cloudflare.com)

Subject: Request to review blocked Pages project arcana-web-qual (error 8000119)

> Account ID: 62710316cacc7264935b52743b01b1fa. Project: arcana-web-qual.
>
> A deployment to this Pages project failed with "Your Pages project has been
> blocked" (code 8000119). I would like to understand what triggered the block
> and ask for a review.
>
> The project is the website and customer portal of Arcana, a subscription VPN
> service operated by [LEGAL NAME / ADDRESS / CONTACT]. It contains the sign-up and
> sign-in pages, billing through Stripe, a customer area for managing VPN access
> links, and an admin area protected by multi-factor authentication. Privacy
> policy: [URL]. Terms: [URL].
>
> The VPN servers are separate machines that I operate; none of the VPN traffic is
> carried through Cloudflare. If part of the project's code (for example the
> endpoint that serves client configuration files) conflicts with the Cloudflare
> Service-Specific Terms, I am willing to remove it from Cloudflare and serve it
> from my own infrastructure. Please tell me which part caused the block so I can
> bring the project into compliance.
>
> Thank you, [NAME]
