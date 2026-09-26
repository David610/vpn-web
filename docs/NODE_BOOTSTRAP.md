# Automated node bootstrap

How a blank VPS becomes a READY Arcana node with no SSH and no human steps.

Status: **INTEGRATED**. The code path is live behind the admin API and
covered by unit tests. It becomes **REAL-INFRA VERIFIED** only after a real
Hetzner node reaches READY through it (see "Evidence" below).

## Flow

```
POST /api/admin/nodes {nodeId, role, locationId, provider:"hetzner", region}
  └─ register_node_create_operation()  (node row + CREATE_NODE op + steps, one txn)
      └─ advanceOperation() inline, then every minute via pg_cron → /api/internal/fleet-tick

CREATE_INSTANCE    adopt server labelled arcana-node-id=<nodeId>, else mint token
                   (hash stored first) and create it with cloud-init user_data
PUBLISH_DNS        upsert A <nodeId>.<FLEET_NODE_DOMAIN> → IPv4 (unproxied, TTL 60)
AWAIT_ENROLLMENT   wait for PROVISIONING → WARMING_UP (node bound its key)
AWAIT_BOOTSTRAP    wait for the node's own report: COMPLETE/OK
VERIFY_READINESS   fresh heartbeat + HTTPS :8443 (valid cert for the hostname)
                   + TCP :443, 3 consecutive passes 20 s apart
MARK_READY         WARMING_UP → READY (guarded)
```

On the VPS, `arcana-node-bootstrap.service` (a oneshot, `Restart=on-failure`)
runs stages ENROLL → DNS_WAIT → INSTALL → AGENT → HEALTH → COMPLETE and
reports each to `POST /api/agent/bootstrap-status`. INSTALL runs the pinned
singbox-vpn release's `install.sh` (checksum + provenance verified), which
also issues and schedules renewal of the Let's Encrypt certificate.

## Credentials

| Secret | Lives | Never |
|---|---|---|
| Enrollment token | Worker memory for one create call; VPS `/etc/arcana/bootstrap.env` (0600) until bound, then deleted | DB (hash only), admin browser, operation records, argv, logs |
| Node API key | Generated on the VPS; `/etc/vpn/provisioning-agent.toml` (0600) | Network (only its SHA-256 is sent), control plane, admin browser |
| Hetzner / Cloudflare / Supabase / Stripe | Pages secrets | Any VPS |

The token remains readable from the provider metadata service on that one
VPS (root-equivalent access already) and via the provider API (already
all-powerful). It is single-use, bound to one key hash, and expires in 1 h.

## Crash / failure recovery

| Failure | Recovery |
|---|---|
| Create call times out but server was created | next tick finds it by label and adopts it; no second server, no new token |
| DB write after create fails | same (adopt by label) |
| Worker dies mid-operation | lease (120 s) lapses; next tick resumes from last persisted step |
| VPS reboots/crashes mid-bootstrap | systemd re-runs the idempotent script; completed stages are skipped |
| Crash after key bound, before node saw the 200 | key was persisted *before* enrolling; retry with same hash → 200 (idempotent); after token TTL, an authenticated heartbeat proves the key |
| Token replayed with a different key | 409 — one token binds exactly one key |
| Node never finishes | 90 min operation deadline → operation FAILED, node FAILED (server kept for inspection; retire to destroy) |

## Configuration

`HETZNER_API_TOKEN`, `CLOUDFLARE_DNS_API_TOKEN` (Zone.DNS:Edit on one zone),
`CLOUDFLARE_DNS_ZONE_ID`, `FLEET_NODE_DOMAIN`, `FLEET_SINGBOX_VPN_VERSION`,
`FLEET_TICK_SECRET`, `FLEET_REALITY_HANDSHAKE_SERVER` (a TLS 1.3 hostname
you control or have deliberately selected as the REALITY decoy for every
node in the fleet — `install.sh` refuses to guess one and dies under
`--non-interactive` without it); optional `FLEET_HETZNER_SERVER_TYPE` (default `cx23`),
`FLEET_HETZNER_IMAGE` (default `alma-9`). Schedule the reconciler once per
project with `scripts/setup-fleet-cron.mjs`.

## What readiness does NOT yet prove

The Worker cannot speak UDP or run a sing-box client, so READY today means
DNS + certificate + TCP listener + agent alive. Hysteria2 and full REALITY
handshake probes run from peer nodes in the synthetic-health phase.

## Evidence

Recorded here once a real run completes (operation id, timings, probe results).
