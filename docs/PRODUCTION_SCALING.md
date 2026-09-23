# Production scaling baseline

Arcana's current target is hundreds of concurrently active customers on the
Cloudflare/Supabase control plane, while keeping the browser usable on older
phones.

## Hosted Supabase Auth settings

`supabase/config.toml` is the local/source-of-truth mirror. The hosted project
must be configured to match it:

- JWT expiry: **3600 seconds**
- Session inactivity timeout: **168h / 7 days**
- Session time-box: **720h / 30 days**
- Refresh-token rotation: **enabled**
- Refresh rate limit: **600 per 5 minutes per source IP**
- Secure password change: **enabled**

Normal sessions therefore survive browser restarts and remain convenient for
days. Financial/security-sensitive actions still use Arcana's separate
15-minute recent-auth requirement.

For the fastest Worker authentication path, use an **asymmetric Supabase JWT
signing key (RSA/ECC)**. `supabase.auth.getClaims(token)` can then verify
against cached JWKS instead of sending every request to GoTrue. If the project
still uses a legacy symmetric signing secret, Supabase securely falls back to
server verification, but the latency win is lost.

## Control-plane load test

Use a non-production test account/token:

```bash
ARCANA_BASE_URL=https://example.com \
ARCANA_ACCESS_TOKEN=... \
CONCURRENCY=100 \
DURATION_SECONDS=30 \
node scripts/load-control-plane.mjs
```

Default gate:

- <= 1% request errors
- p95 <= 1500 ms

Run the same test at 25, 50, 100, 200, then 300 concurrency. Record Cloudflare
Function errors, Supabase DB/API metrics and latency at each step.

## Phone performance rules

- no web fonts
- static pages/assets stay on Cloudflare Pages' CDN
- no sticky backdrop blur on <=768px screens
- usage polling stops when telemetry is unavailable
- usage polling pauses in hidden tabs
- browser target is pinned through iOS Safari 12 / Safari 12
- authenticated dashboard initial state avoids the duplicate account API call

Do not add client-side analytics, animation libraries, charting libraries, or
large icon packs to customer pages without a measured bundle/performance budget.

## Provisioning throughput

The VPS agent:

- polls at 3s only when idle
- drains pending jobs back-to-back under load
- reports traffic every 15s and heartbeat every 60s independently
- never reruns a successful vpn-admin side effect merely because completion
  acknowledgement temporarily failed
- retries completion/failure acknowledgement indefinitely with capped backoff

The data plane is still capacity-bound by the VPS. Before claiming support for
hundreds of simultaneous VPN tunnels, run 25/50/100/200 concurrent tunnel load
tests on the production-sized VPS and record CPU, RAM, network, packet loss,
latency, file descriptors, connection counts and sing-box stability.
