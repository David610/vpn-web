# Backup/restore and secret rotation runbook

Status: **UNVERIFIED — never executed**. This is an executable runbook, not a
completed drill. It was written from code (this repo has no production
credentials of any kind available to it — confirmed by an empty
`env | grep -iE "SUPABASE|STRIPE|CLOUDFLARE|HETZNER|TELEGRAM|RESEND"` in this
session's container) and from `docs/PRODUCTION_CONFIG.md` /
`scripts/verify-fleet-backup-restore.sql`, which already exist. Nobody should
call the backup/restore claim in the final readiness document "done" until a
human with real Supabase/Cloudflare/Stripe/Hetzner access has actually run
this once and recorded the timings below.

A backup that has never been restored is not a recovery system. This
document exists so that the first real restore is a checklist, not an
improvisation.

## 1. Backup/restore drill

### Prerequisites (a human with dashboard access does this, not an agent)

- A Supabase organization with billing that allows creating a second project
  (the restore target must be an *isolated* project, never a restore-in-place
  onto production).
- Access to the production Supabase project's backup list (Dashboard →
  Database → Backups; on paid tiers this includes point-in-time recovery).
- A copy of every secret in `docs/PRODUCTION_CONFIG.md`'s "secret" rows
  (`VPN_SECRETS_ENCRYPTION_KEY`, `ROUTE_SIGNING_PRIVATE_KEY`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, node/provider/Cloudflare/
  Telegram tokens) available to paste into the restore target's own Cloudflare
  Pages environment — **the restore target gets its own copy of secrets that
  matter for read-only verification (the encryption key, so existing
  ciphertext is readable) but must NOT share the production Stripe webhook
  endpoint, production DNS zone, or production node fleet.** This drill
  verifies data integrity and application boot, not a live payments/DNS
  cutover.

### Steps

1. **Snapshot.** Take (or select an existing automatic) backup of the
   production Supabase project. Record the backup's timestamp — this is
   your **RPO measurement**: production data as of that timestamp is what
   survives a real disaster, i.e. RPO ≈ time since the last backup at the
   moment of failure (for Supabase's default daily backups, worst case
   RPO ≈ 24h; point-in-time recovery reduces this to minutes if enabled —
   record which tier is active).
2. **Restore to an isolated target.** Create a new, separate Supabase
   project. Restore the snapshot into it (Supabase dashboard restore flow,
   or `pg_restore` from a logical dump if self-managing). Record the
   wall-clock time from "restore started" to "restore reports complete" —
   this is your **RTO measurement** for the database layer alone (the full
   application RTO also includes steps 3-7 below; record a total too).
3. **Verify schema/integrity before touching the app.** Run
   `psql "$RESTORED_DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify-fleet-backup-restore.sql`
   against the restored project. This already checks: every migration
   actually applied (not a stale subset), referential integrity held across
   the restore, and core tables aren't suspiciously empty. It aborts
   non-zero on the first real problem — do not proceed past a failure here.
4. **Apply secrets to the restore target.** In the restored project's own
   Cloudflare Pages preview/staging deployment (never point production DNS
   at this), set: the restored project's own Supabase URL/anon/service-role
   keys (from the NEW project, not copied from production), plus
   `VPN_SECRETS_ENCRYPTION_KEY` (must be the SAME key as production — it's
   what makes the restored ciphertext readable; this is the one secret this
   drill genuinely needs copied verbatim), `ROUTE_SIGNING_PRIVATE_KEY`/
   `ROUTE_SIGNING_KEY_ID` (same, for `/v1/routes` to sign correctly), and a
   **test-mode** `STRIPE_SECRET_KEY` (never the live key — this drill must
   not be able to charge a real card or cancel a real subscription).
5. **Launch the control plane** against the restored database (deploy this
   repo's current branch to the staging/preview Cloudflare Pages project
   pointed at the restored Supabase project).
6. **Login test account.** Use a real (or seeded) test account. Confirm:
   - login succeeds (Supabase Auth against the restored project works);
   - `GET /api/account/overview` shows the expected subscription(s);
   - `GET /api/account/devices` shows the expected devices;
   - device entitlement (`public.device_entitlement()`) returns the same
     verdict it would have on production for that account/device pair;
   - `GET /v1/routes` returns a signed directory (proves
     `ROUTE_SIGNING_PRIVATE_KEY` round-trips correctly against the restored
     key material);
   - `POST /v1/vpn/authorize` for an entitled device returns a lease (proves
     `VPN_SECRETS_ENCRYPTION_KEY` correctly decrypts restored ciphertext).
7. **Record results.** Fill in the table below and commit it to this file (or
   a dated copy of it) so the NEXT drill has a baseline to compare against.
   Tear down the restore target's staging deployment and the extra Supabase
   project once verification is complete — don't leave a second copy of
   customer data running indefinitely.

### Results (fill in after running — currently blank, drill not yet performed)

| Metric | Target | Actual | Date | Notes |
|---|---|---|---|---|
| RPO (backup tier / PITR window) | — | UNVERIFIED | — | |
| RTO — database restore only | — | UNVERIFIED | — | |
| RTO — full app (steps 1-6) | — | UNVERIFIED | — | |
| `verify-fleet-backup-restore.sql` result | pass | UNVERIFIED | — | |
| Login + overview + devices | pass | UNVERIFIED | — | |
| `/v1/routes` signs correctly | pass | UNVERIFIED | — | |
| `/v1/vpn/authorize` decrypts correctly | pass | UNVERIFIED | — | |

## 2. Secret rotation runbooks

Each secret below: what it protects, blast radius if leaked, and the
rotation procedure. None of these have been executed or tested this
session (no live credentials available) — each is written from the code
that consumes the secret, so verify the exact steps against the current
Cloudflare/Supabase/Stripe dashboards before running for real, since a
dashboard UI can drift from what's written here.

### `VPN_SECRETS_ENCRYPTION_KEY` (AES-GCM, `functions/lib/crypto.js`)
- **Protects**: every stored VPN setup URL/lease secret/obfs password at
  rest in `vpn_secrets`/`node_transport_secrets`/lease tables.
- **Leak blast radius**: leaking this key *plus* a database backup/dump
  exposes every customer's VPN credentials ever issued. The key alone
  (without the data) exposes nothing.
- **Loss blast radius**: losing this key with no backup makes every
  stored ciphertext permanently unreadable — this is a single key with
  **no key id and no rotation path in the current schema** (confirmed by
  the original 2026-09-27 audit; this session did not add key-id support,
  since that's a schema/format change requiring dual-read during rollover,
  not a config change — recommend a follow-up if this key needs a genuine
  live-rotation capability, not swap-and-restart).
- **Rotation procedure (today's capability — restart-time swap, not
  live rollover)**: generate a new 32-byte hex key. Decrypt every row
  under the OLD key and re-encrypt under the NEW key in a single
  maintenance-window migration script (write one before attempting this
  live — none exists in `scripts/` today), then swap the Cloudflare Pages
  env var. Any in-flight request during the swap that reads with the new
  key against not-yet-re-encrypted rows will fail — this is why it's a
  maintenance-window operation, not a hot rotation, until key-id support
  is added.
- **Escrow**: store the current key in a secrets manager separate from
  the Cloudflare Pages dashboard (e.g. a password manager's shared vault)
  — losing Cloudflare account access must not also mean losing this key.

### `ROUTE_SIGNING_PRIVATE_KEY` / `ROUTE_SIGNING_KEY_ID` (Ed25519, `/v1/routes`)
- **Protects**: authenticity of the signed route directory tamara-next
  clients trust.
- **Leak blast radius**: an attacker with this key can sign a malicious
  route directory and MITM clients that trust it — high severity.
- **Loss blast radius**: none for existing data (this only signs live
  responses); losing it just means generating a new one and re-signing
  going forward.
- **Rotation**: tamara-next's client already supports a *key set*
  (`TAMARA_ROUTE_SIGNING_KEYS`), the server signs with one key at a time
  (per the original audit). Rotation is: generate a new Ed25519 keypair,
  add its public key + a new `ROUTE_SIGNING_KEY_ID` to the client-trusted
  set (a tamara-next release, out of this repo), THEN swap vpn-web's
  `ROUTE_SIGNING_PRIVATE_KEY`/`ROUTE_SIGNING_KEY_ID` env vars, THEN once
  every client has the new key trusted, remove the old key id from the
  client's trusted set in a later release. Never remove client trust for a
  key id before the server has stopped signing with it, and never swap the
  server's signing key before clients trust the new key id — either
  ordering mistake breaks every client until the next release.

### `STRIPE_WEBHOOK_SECRET`
- **Protects**: authenticity of incoming `/api/stripe-webhook` calls
  (`constructEventAsync`, `functions/lib/stripe-events.js`).
- **Leak blast radius**: an attacker who has this AND can reach the
  webhook endpoint could forge billing events (fake payments, fake
  cancellations) — high severity for billing integrity.
- **Rotation**: Stripe Dashboard → Webhooks → the endpoint → "Roll secret"
  generates a new one while the old one still verifies for a grace window
  Stripe defines; update the Cloudflare Pages env var within that window.
  No code change needed — this is a pure secret-value swap.

### `STRIPE_SECRET_KEY`
- **Protects**: every Stripe API call this app makes (checkout, portal,
  subscription mutation).
- **Leak blast radius**: full account-level Stripe API access — sees
  everyone's payment data, can create/cancel/refund. Treat as
  emergency-severity if leaked.
- **Rotation**: Stripe Dashboard → Developers → API keys → roll the key.
  Stripe supports a grace period where both old and new keys work; update
  the Cloudflare Pages env var within it, then confirm the old key is
  revoked. **Rotate immediately, out of band from any scheduled rotation,
  if this key is ever suspected leaked** — it is the single highest-blast-
  radius secret in this system after the VPN encryption key.

### Supabase credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, anon key)
- **Protects**: `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely — it is
  effectively root on the database from any Cloudflare Pages Function.
- **Leak blast radius (service-role key)**: total database compromise —
  read/write every table, bypass every RLS policy. Emergency-severity.
- **Rotation**: Supabase Dashboard → Project Settings → API → "Roll" the
  service-role key (this immediately invalidates the old one — there is
  no grace window on Supabase's side the way Stripe offers one, so this
  IS a brief-outage operation: update the Cloudflare Pages env var as
  fast as possible after rolling, ideally scripted/staged so the gap is
  seconds, not minutes). The anon key is public by design (it's shipped
  in the client bundle) and only needs rotation if RLS itself is found
  broken, not on a routine schedule.

### Node API keys (per-node, `functions/lib/node-auth.js`)
- **Protects**: agent authentication for `/api/agent/*`.
- **Leak blast radius**: scoped to ONE node (see the original audit's
  provisioning-agent-trust analysis — a compromised node key cannot read
  other nodes' jobs/leases/customer data). Low-to-medium severity, and
  contained.
- **Rotation**: this session's Phase 5/8 work added real revocation
  (`revoke_node_key_and_transition`, quarantine/retire flows) but rotation
  (issuing a NEW key to a node that keeps running, vs. revoking on retire)
  has no dedicated endpoint today — the closest existing mechanism is
  re-enrollment (FAILED→PROVISIONING issues a fresh enrollment token,
  which mints a new key on next bootstrap). A live, non-disruptive
  "rotate this node's key without a full re-provision" endpoint does not
  exist; flagging as a gap for a follow-up if per-node key rotation
  (rather than revoke+re-enroll) is a real operational need.

### Cloudflare credentials (API token for DNS management, Pages deploy)
- **Protects**: DNS record management (`deleteRecord`/`upsertRecord` for
  node lifecycle) and the ability to deploy this app.
- **Leak blast radius**: DNS takeover of the managed zone (redirect/MITM
  traffic), or unauthorized deploys. High severity.
- **Rotation**: Cloudflare Dashboard → My Profile → API Tokens → roll the
  token; update the Cloudflare Pages env var (for the DNS-management
  token used by fleet operations) and any CI/deploy credential (for the
  Pages-deploy token) separately — these should be two distinct tokens
  with distinct, minimal scopes, not one broad token used for both.

### Provider token (Hetzner Cloud API token)
- **Protects**: the ability to create/destroy VPS instances.
- **Leak blast radius**: an attacker can spin up (billed to the account)
  or destroy production nodes. Medium-high severity (cost + availability,
  not customer data — node provisioning doesn't touch customer secrets
  directly).
- **Rotation**: Hetzner Cloud Console → Security → API Tokens → generate
  a new one, revoke the old, update the Cloudflare Pages env var.

### Telegram bot secret (bot token)
- **Protects**: the bot's identity; `initData` HMAC verification uses it.
- **Leak blast radius**: an attacker could run a bot impersonating this
  one, or (combined with the HMAC scheme) potentially forge `initData` —
  re-read `functions/lib/telegram-auth.js`'s exact HMAC construction before
  assuming forgery is or isn't possible with just the token; treat as
  high severity regardless.
- **Rotation**: Telegram @BotFather → `/revoke` the current token, get a
  new one, update the Cloudflare Pages env var. Existing `telegram_links`
  rows are unaffected (they key on Telegram user id, not the bot token).

## 3. What this runbook does NOT cover

- Actually running any of the above. That requires a human with the real
  dashboards and is explicitly out of scope for this session (no live
  credentials, and even with them, live secret rotation and DNS/Stripe
  changes are Phase-17-gate actions requiring the user's explicit
  approval per this remediation's own rules).
- Choosing an external paging/alerting destination for when a rotation or
  restore goes wrong — that's a separate infrastructure decision (see
  the observability phase's findings).
