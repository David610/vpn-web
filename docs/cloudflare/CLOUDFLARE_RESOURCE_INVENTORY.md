# Cloudflare resource inventory

Snapshot 2026-10-16 from the Cloudflare API with the token supplied for this work (read scope only; gaps listed). Account `62710316cacc7264935b52743b01b1fa`, plan **Free** (all six zones report "Free Website").

## Zones
| Zone | Purpose | Calls it | Notes |
|---|---|---|---|
| `mkhitaryan.io` | Personal site (`test` Pages project) + Migadu mail | browsers | `@`/`www` proxied CNAME → `test-ai6.pages.dev` |
| `sustechnologies.eu` | Fleet node DNS zone (per `docs/PRODUCTION_CONFIG.md`) + Migadu mail | `functions/lib/dns-adapter.js` via `CLOUDFLARE_DNS_API_TOKEN` | Only mail records exist now; heavy create/delete history in the audit log |
| 4 Cyrillic-named zones (xn--… punycode) | Node hostnames (`vpn.<zone>`) per operator notes | VPN clients | Records churn on 09-06…10-13; contents not read |

## Compute / storage
| Resource | Exists? | Purpose | Quota consumed | If unavailable |
|---|---|---|---|---|
| Pages `first-consulting-website` | yes | Consulting site (Functions present, ~10–500 req/day) | Workers req + CPU | Site only |
| Pages `test` (domains mkhitaryan.io, www) | yes | Portfolio | same | Site only |
| Pages `arcana-web-epw`, `arcana-web-qual` | **deleted 2026-10-10 06:50Z** | Arcana website + all `/api/*`, `/sub/*`, `/v1/*` Functions | Workers req + CPU (this was the incident) | **Arcana control plane is currently down** (nodes cannot claim jobs/sync leases; website/portal gone) |
| Workers scripts, KV, D1, R2*, Durable Objects, Queues, Tunnels | **none** | — | — | — |
| WAF / rate-limit rules | unreadable (403) | — | — | Token needs `Zone > Firewall Services:Read` |
| Scheduled triggers | none in Cloudflare; node-side `systemd` timers and GitHub Actions only | — | — | — |

\* R2 listing returned 403, so existence is unconfirmed.

## Callers of the (deleted) Arcana Pages Functions
| Caller | Endpoints | Rate (measured/derived) | Cloudflare quota |
|---|---|---|---|
| Provisioning agent on each node (`singbox-vpn/apps/provisioning-agent`) | `/api/agent/{claim,authorizations,leases/sync,heartbeat,traffic,probe-*,jobs/*}` | 3 calls / 3 s + heartbeat 60 s (derived from code; matches 7,000 req/h) | Workers req + CPU |
| Website / portal / Telegram Mini App | `/api/account/*`, `/v1/links*`, `/api/admin/*` | not measured (project deleted) | same |
| VPN clients (Hiddify, Shadowrocket, Incy) | `/sub/[token]` | not measured; client-controlled update interval | same |
| Stripe | `/api/stripe-webhook` | event-driven | same |
| Fleet automation | Cloudflare **DNS API** from Functions | audit log: dozens of ops/day | DNS API limit (not Workers) |

## Data plane vs control plane
```
Client ─(REALITY/Hysteria2, direct to node IP/hostname)──────────────► sing-box on node   [DATA PLANE: no Cloudflare, no control-plane call per connection]
Client ─HTTPS /sub/<token>──► Cloudflare Pages Function ─► Supabase     [CONTROL: config/subscription delivery]
Agent ─HTTPS /api/agent/* ──► (was) Pages Function ─► Supabase          [CONTROL: jobs, authorizations, leases]
Agent ─HTTPS /api/agent/* ──► (now) api.<host> ► Caddy ► Node API ► Supabase   [CONTROL, off Workers]
```
Node-side enforcement of credential validity (`valid_until`) is local; an established tunnel does not call the control plane. Credential *issuance/renewal/revocation* does (see CLOUDFLARE_RELIABILITY.md for failure behaviour).

## Tokens and automation
* `CLOUDFLARE_DNS_API_TOKEN` (documented as scoped to `sustechnologies.eu` Zone.DNS:Edit) and `CLOUDFLARE_DNS_ZONE_ID` — runtime secrets of the Functions; **will be needed by the VPS API too if fleet-DNS routes move** (they are not part of `/api/agent/*`, so the agent-only host does not receive them).
* Deploy token for Pages: operator-held; the Claude session cannot run `wrangler deploy`.
* GitHub Actions in `vpn-web` and `singbox-vpn`: CI only; no scheduled job calls Cloudflare.
* The token used for this audit was pasted into a chat and **must be rotated**.

## Unknowns
Per-hostname Arcana DNS records (the live API/website hostnames), WAF/rate-limit rules, billing/notification settings, and node-side agent configs.
