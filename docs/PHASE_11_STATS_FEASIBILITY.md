# Phase 11: per-device traffic stats — feasibility spike

Status: **not feasible with the currently pinned sing-box build. Capability-gated, not built.**

## Finding

Per-device traffic counters are **not trustworthy** with sing-box 1.14.1 as
built and distributed by upstream (the version this fleet actually runs —
see `singbox-vpn/docs/COMPATIBILITY_VERSIONS.md`), and this repo's current
config shape doesn't change that conclusion. This was already investigated
and documented in detail on the singbox-vpn side, in
`singbox-vpn/docs/TRAFFIC_ACCOUNTING.md` and
`singbox-vpn/apps/provisioning-agent/src/stats.rs`; this document is the
vpn-web-side confirmation and the resulting UI decision, not a re-derivation
from scratch.

### What was verified (not inferred)

- The natural mechanism — sing-box's V2Ray-compatible stats service
  (`experimental.v2ray_api.stats`, per-named-user `user>>>NAME>>>traffic>>>*`
  counters) — **is not compiled into the official sing-box release binary**.
  `singbox-vpn/docs/TRAFFIC_ACCOUNTING.md` records the actual failure output
  (`sing-box check` against a `v2ray_api` config: `FATAL create v2ray-server:
  v2ray api is not included in this build, rebuild with -tags
  with_v2ray_api`) and the official 1.14.1 build-tag manifest, which lists
  `with_clash_api` but not `with_v2ray_api`. Upstream's own documentation
  table claiming `with_v2ray_api` is on by default is wrong (or describes a
  non-release build) — the pinned binary's behavior is the source of truth
  here, not the docs table.
- The one stats surface that **is** compiled in, the Clash API
  (`GET /connections`), was checked against a real running instance with a
  named VLESS user and does **not** attribute traffic to a user: connection
  metadata is `destinationIP, destinationPort, dnsMode, host, network,
  processPath, sourceIP, sourcePort, type` — `type` is the inbound tag
  (shared across every user of that inbound), not a per-user identifier.
  Closed connections also drop out of the list entirely, surviving only in
  instance-wide totals — which is exactly why the existing node-level
  accounting (`node_traffic_samples`/`node_traffic_daily`, ingested via
  `functions/api/agent/traffic.js` from the agent's Clash-API poll) works,
  and why summing per-connection Clash entries as a per-device proxy would
  silently under-count.
- Getting real per-user attribution would mean building sing-box from source
  with `-tags with_v2ray_api` and teaching the provisioning-agent to speak
  the V2Ray `StatsService` over gRPC (the stats service has no HTTP
  transport) — a custom-binary, custom-build-pipeline, custom-agent-protocol
  commitment. That is a product decision (accept losing "drop in an official
  signed release for a security fix"), explicitly out of scope for a
  feasibility spike, and not something this phase should force into
  existence just to ship a feature.

### What was checked on the vpn-web side for this phase specifically

- `functions/api/admin/nodes.js`'s traffic block (`node.traffic.*`) is
  fed by `node_traffic_samples`/`node_traffic_daily`, which are populated
  from the agent's node-level Clash API poll — confirmed per-node, not
  per-device, both by the ingest code and by the comment already in that
  file.
- `functions/api/account/devices.js` (Phase 9) was audited for any
  per-device traffic/usage field, placeholder, or reused node-level number
  presented as per-device. **It has none** — the response carries only
  `id, name, platform, status, createdAt, lastSeenAt, assignment`. Phase 9
  did not overclaim; there was nothing to gate.
- `src/components/DevicesCard.tsx` was likewise audited: it renders name,
  platform, status, and the profile-assignment control. No traffic/usage UI
  exists to gate.

## Decision

No per-device stats ingestion path, table, or UI was built. Building one
would require either misattributing per-node totals to individual devices
(dishonest — exactly what the spike's own charter forbids) or shipping a
custom sing-box build and a new gRPC stats protocol (a real, separate
product decision, not a spike deliverable).

Instead, this phase adds an explicit **capability gate**: a code comment on
`GET /api/account/devices` (functions/api/account/devices.js) stating why no
traffic field belongs there and warning against reusing node-level totals,
plus a regression test
(`functions/api/account/__tests__/devices.test.js`, "never reports
per-device traffic/usage figures") that fails if a future change adds a
`traffic`/`usage`/`bytes*`-shaped field to that response without a
deliberate, reviewed decision to revisit this finding.

## Revisiting this later

This finding is scoped to the *official* sing-box release line. If a future
phase decides the custom-build tradeoff is worth it (a real V2Ray-API
stats binary + gRPC agent client), that phase should start from
`singbox-vpn/docs/TRAFFIC_ACCOUNTING.md`'s "What it would take" section, and
this document's regression test should be removed/updated deliberately at
that point — not worked around silently.

## Addendum (2026-09-25): account-wide UsageCard retired with the old dashboard

`src/components/UsageCard.tsx` and `GET /api/vpn/usage` predate this
document's decision above — they show *account-wide* live/monthly traffic
via a single VPN config's Clash-API totals, from back when an account had
exactly one VPN profile. That single-profile assumption no longer holds
under the ADR-0001 commercial model (one account, many subscriptions, many
devices), and the account IA rebuild (`/account/*`, replacing `/dashboard`)
has no page it fits cleanly into: it is neither per-device (already ruled
out above) nor per-subscription (the account only has one Clash-API
source, not one per subscription, so a per-subscription figure would be
just as misattributed as a per-device one).

`UsageCard` was not carried over to `/account/*` and is now dead code
(nothing in `src/app/` imports it after `src/app/dashboard/page.tsx` was
replaced with a redirect). It is left in place, unimported, rather than
deleted, in case a future phase revisits `GET /api/vpn/usage` as part of
scoping real per-subscription telemetry — deleting it now would just mean
rewriting the same rendering logic later. Do not re-wire it into `/account/*`
without first deciding what VPN-profile/Clash-API scope it should actually
read from under the multi-subscription model.
