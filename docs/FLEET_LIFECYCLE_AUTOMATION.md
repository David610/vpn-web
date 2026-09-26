# Fleet lifecycle automation

How a node moves through its lifecycle after it first reaches READY:
health-driven failover, replacement (manual or automatic), canary-gated
replacement, and capacity-driven scale-out. See `docs/NODE_BOOTSTRAP.md`
for how a node is created in the first place.

Status: **INTEGRATED**. Every flow below is live behind its own feature
flag (default off except the always-on health-transition bookkeeping) and
covered by unit tests. None of it is **REAL-INFRA VERIFIED** yet — no real
run has been recorded (see "Evidence").

## Lifecycle states

```
PROVISIONING -> WARMING_UP -> READY <-> DEGRADED
                    |            |         |
                    v            v         v
                 CANARY       DRAINING <---+
                    |            |
                    +--> READY   +--> MAINTENANCE
                    |            |
                    +--> FAILED  +--> RETIRED
                                 |
                    (from READY/DEGRADED/FAILED/CANARY)
                              QUARANTINED --> RETIRED  (one-way)
```

The full transition table lives in `functions/lib/node-lifecycle.js`
(`ALLOWED_TRANSITIONS`) — it is what an **admin** may do by hand via
`PATCH /api/admin/nodes/:id/lifecycle`. Automation never gets everything
that table allows: each automated flow below spells out its own narrower
set of moves and uses the table only as a secondary guard.

QUARANTINED is a one-way security control (spec §45 blast-radius
containment) — a quarantined node never returns to serving traffic; the
only way out is RETIRED, then provisioning a fresh replacement.

## Protocol-level probes (Phase 4, `protocol-health.js`)

Each agent runs a real local sing-box client against up to 3 peer nodes
(`GET /api/agent/probe-targets`), and against itself over loopback as a
fallback. The probes cover REALITY and Hysteria2. The results come back on
the heartbeat as `protocol_probe`, with one `node_probe_results` row per
dimension: tcp_connect, handshake, https_ipv4, dns, ipv6, egress_ip,
latency, loss and useful_egress. Rows are kept for 24 h, capped at 5000 per
target. The latest summary is stored on `nodes.protocol_health`, and the
Hysteria2 certificate expiry on `nodes.hysteria2_cert_days`.

Only one of these signals drives lifecycle. That signal is useful egress
(handshake plus IPv4 HTTPS) for each reported protocol, and it goes through
the same 3-fail/5-pass hysteresis on separate `protocol_probe_*` counters.
If either REALITY or Hysteria2 fails 3 reports in a row, a READY node
becomes DEGRADED.

Precedence and guards:

* Peer results win over self results. Self results count only when no peer
  has reported on the node within 3 heartbeat intervals.
* DEGRADED -> READY needs both the Clash probe and the protocol probe to be
  healthy.
* Protocol evidence never moves a node into or out of FAILED. FAILED stays
  silence-only, and `failed_reason` recovery rules are unchanged.

The following are informational only and never drive lifecycle: DNS, IPv6,
egress-IP match, latency, loss, certificate days and
`nodes.ip_reputation`.

Probe credentials: each node creates a reserved, non-customer
`arcana-probe` user locally and publishes its links with
`POST /api/agent/probe-credential`. The links go into
`node_probe_credentials`, which is service-role only. They are served only
to authenticated agents in WARMING_UP, READY or DEGRADED, and never to
admins. Real-VPS evidence is in singbox-vpn `docs/HEALTH_PROBE_EVIDENCE.md`.

## Health-driven transitions (Phase 8, `node-health-transition.js`)

Always running (no feature flag) whenever a node reports telemetry or is
probed:

| Transition | Trigger |
|---|---|
| READY -> DEGRADED | `FAILURE_THRESHOLD` (3) consecutive failed probes |
| DEGRADED -> READY | `SUCCESS_THRESHOLD` (5) consecutive passing probes |
| READY/DEGRADED -> FAILED | silence: no heartbeat for `HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER` (60s x 3 = 3 min) |
| FAILED -> READY | one heartbeat with a passing probe after a silence-triggered FAILED (or any heartbeat at all, for a node with no probe capability) |

Silence detection only applies to `SILENCE_ELIGIBLE_STATES` (READY,
DEGRADED) — a CANARY node's silence is instead handled by
`AWAIT_CANARY` (below), not by this path.

Gated by `FEATURE_AUTO_NODE_HEALTH` for the parts that actually *write*
lifecycle_state — both `agent/heartbeat.js`'s probe-driven
READY<->DEGRADED transitions and `admin/nodes.js`'s lazy silence-based
FAILED detection (run when the admin nodes list is fetched). The
probe-streak bookkeeping itself
(`consecutive_probe_failures`/`consecutive_probe_successes`) always runs
regardless of the flag.

## Replace-node (Phase 12a, `fleet-operations.js`'s `REPLACE_NODE_STEPS`)

Provisions a brand-new node exactly like `POST /api/admin/nodes` (reuses
every `CREATE_NODE` step unmodified), then once the new node is READY,
drains and retires the old one:

```
CREATE_INSTANCE .. MARK_READY   (identical to node creation)
DRAIN_OLD_NODE     old node -> DRAINING; waits until it has zero device
                   assignments or a max-wait deadline elapses, whichever
                   first (passive drain — devices reconnect elsewhere via
                   the scheduler's READY/CANARY-only candidate filter)
RETIRE_OLD_NODE    old node -> RETIRED; destroys its provider instance
                   (idempotent — safe to retry)
```

**Trigger it manually:**

```bash
POST /api/admin/nodes/:oldNodeId/replace
{ "newNodeId": "...", "region": "...", "maxWaitHours": 72, "canary": false }
```

Eligible source states: READY, DEGRADED, FAILED. `provider` defaults to
the old node's own provider if omitted. `maxWaitHours` (1-720, default 72)
bounds the drain wait before the drain is forced through regardless of
remaining assignments.

**Auto-trigger** (`node-auto-replace.js`, gated by
`FEATURE_AUTO_NODE_REPLACE` + `FLEET_AUTO_REPLACE_REGION`): every
`fleet-tick`, replaces any node FAILED longer than
`AUTO_REPLACE_AFTER_FAILED_MS`, skipping a node whose *own* provisioning
attempt never reached READY (it needs its own retry/cleanup, not a
"replacement") and any node with a replacement already in flight
(`fleet_operations.idempotency_key = "REPLACE_NODE:<nodeId>"`, permanent
regardless of that attempt's outcome).

## Canary rollout (Phase 12b, `AWAIT_CANARY` step)

Opt-in refinement of replace-node: instead of trusting the new node
immediately, hold it to a capped share of real traffic for an observation
window before promoting it.

- `canary: true` on the manual replace call, or
  `FEATURE_AUTO_NODE_REPLACE_CANARY=true` for the auto-trigger.
- `MARK_READY` sends the new node to **CANARY** instead of READY.
- The scheduler (`scheduler.js`) includes CANARY nodes as candidates, but
  caps their effective session count at `CANARY_SESSION_CAP` (10)
  regardless of the node's own `max_sessions`.
- `AWAIT_CANARY` runs once per tick while the node is CANARY:
  - **Abort** to FAILED if the node has gone silent (no heartbeat for
    `HEARTBEAT_INTERVAL_MS * SILENCE_THRESHOLD_MULTIPLIER`) or hit
    `FAILURE_THRESHOLD` consecutive probe failures — the **old node is
    never touched** in this case (DRAIN_OLD_NODE hasn't run yet).
  - **Promote** to READY once `CANARY_OBSERVATION_MS` (2 hours) has
    elapsed without an abort — falls through to DRAIN_OLD_NODE exactly
    like the non-canary path.
  - Otherwise waits one poll cycle (`DRAIN_POLL_INTERVAL_S`, 300s).

**Fixed** (previously an open known limitation in the Phase 12b spec): a
`nodes.failed_reason` column now records why a node entered FAILED
(`SILENCE`, `CANARY_ABORT`, `BOOT_TIMEOUT`, or `ADMIN`). Phase 8's
`FAILED -> READY` auto-recovery in `evaluateProbeResult`
(`node-health-transition.js`) only fires when `failed_reason` is
`SILENCE` — the one case it was designed to reverse from a single
passing probe or bare heartbeat. A canary abort, a boot timeout, or an
admin-forced FAILED all stay FAILED regardless of probe result until an
admin acts or a real replacement lands. `FEATURE_AUTO_NODE_REPLACE_CANARY`
/ `canary: true` may now be combined safely with `FEATURE_AUTO_NODE_HEALTH`.

## Capacity-aware auto-scale (Phase 12c, `node-auto-scale.js`)

Handles the case a single-device scheduling request can't: an entire
`(location, role)` group with no headroom left in *any* of its serving
nodes, not just one device's placement failing closed.

Gated by `FEATURE_AUTO_NODE_SCALE` + `FLEET_AUTO_SCALE_REGION`. Every
`fleet-tick`:

1. Groups all nodes by `(location_id, role)`.
2. A group is **capacity-exhausted** if it has at least one currently
   serving node (READY/CANARY) and *none* of them has headroom (reusing
   the scheduler's own `isUnderCapacity()` — a CANARY node's low
   `CANARY_SESSION_CAP`, not its raw `max_sessions`, counts).
3. Skipped if a node in that group is already PROVISIONING/WARMING_UP —
   a scale-out is already in flight and will relieve capacity once ready.
4. Otherwise starts a plain `CREATE_NODE` operation (not a replacement,
   no old node involved) for a new node there, copying `provider` from an
   existing node in the group. The new node's id is
   `<template-base>-cap<N>`, picking the lowest N not already taken by
   *any* node with that base regardless of lifecycle state — a failed
   scale-out attempt permanently occupies its id (primary key), so the
   next attempt must pick a fresh one rather than retrying the same id
   forever.

One new node per exhausted group per tick; step 3's in-flight check
prevents piling up more until the first one lands.

## Feature flags

| Flag | Default | Gates |
|---|---|---|
| `FEATURE_MULTI_NODE_SCHEDULING` | off | scheduler.js used at all vs. legacy single-node path |
| `FEATURE_AUTO_NODE_HEALTH` | off | admin nodes list writing health-driven lifecycle_state changes |
| `FEATURE_AUTO_NODE_REPLACE` | off | node-auto-replace.js's fleet-tick trigger |
| `FEATURE_AUTO_NODE_REPLACE_CANARY` | off | auto-triggered replacements pass `canary: true` — safe to combine with `FEATURE_AUTO_NODE_HEALTH` (see failed_reason above) |
| `FEATURE_AUTO_NODE_SCALE` | off | node-auto-scale.js's fleet-tick trigger |

## Configuration

`FLEET_AUTO_REPLACE_REGION` (auto-replace's provisioning region — no
per-node region is stored, so this is fleet-wide), `AUTO_REPLACE_AFTER_FAILED_MS`
(how long a node must be FAILED before auto-replace picks it up),
`FLEET_AUTO_SCALE_REGION` (same simplification, for auto-scale). Both
auto-triggers also require the same provisioning config as manual node
creation (`HETZNER_API_TOKEN`, `CLOUDFLARE_DNS_API_TOKEN`/`_ZONE_ID`,
`FLEET_NODE_DOMAIN`, `FLEET_SINGBOX_VPN_VERSION`) — see
`docs/NODE_BOOTSTRAP.md`.

## Evidence

Recorded here once a real run of each flow completes against live
infrastructure (operation id, timings, outcome). Deferred pending staging
access — see each phase's plan document's Task 6.
