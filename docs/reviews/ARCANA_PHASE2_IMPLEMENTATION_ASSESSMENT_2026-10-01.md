# Arcana Phase 2 implementation assessment (2026-10-01)

This assessment was written before Phase 2 implementation changes.

## Repository and CI state

The checked-out branch starts at `1e851a7`. The repository snapshot has no
configured remote. An `origin` remote was added for the requested update, but
the environment's outbound GitHub tunnel returned HTTP 403, so neither latest
`main`, GitHub Actions state, nor `singbox-vpn` PR #125 at
`818bdcbc4319120e1e5df3dda860e9121a0a8bdf` could be fetched. Consequently,
cross-repository qualification must remain an explicit completion blocker; the
implementation must not claim compatibility beyond the contract supplied in
the Phase 2 brief.

The local CI definition runs production dependency audit, lint, unit tests,
static Next.js build, an enforced-CSP Chromium hydration check, accessibility
checks, SQL replay/tests on PostgreSQL 16, and Supabase migration smoke tests.
The resolved application line is Next.js 15.5 (`^15.5.11`) on React 19.1 and
Node 22. Dependency/security currency still requires an online advisory check.

## Current architecture

* Customer and admin APIs use independently validated Supabase bearer sessions;
  every admin API passes through the existing AAL2 gate.
* `devices` is the current seat-bearing identity. Capacity is three included
  devices plus paid packs in multiples of three. `device_entitlement()` is the
  central entitlement check, but existing device insertion does not provide a
  single atomic "claim final seat and create device" primitive suitable for a
  new external-device API.
* Native `/v1/vpn/authorize` uses a transaction-safe ephemeral node slot pool.
  It already renews a live route lease without changing slot secrets and caps
  renewal using node policy. Revocation marks slots for node rotation, including
  an urgent flag.
* `vpn_leases` still directly links account, device, logical/concrete route, and
  timestamps. Its default retention is 30 days; this is more linkable and longer
  lived than necessary for short authorization records.
* The route directory exposes content-derived physical-route identifiers. It
  does not yet provide a stable customer logical-product ID whose physical node
  mapping can move independently.
* Provisioning jobs and legacy `vpn_accounts` remain account/device-linked and
  some payload builders include `user_id` and `device_id`. Those legacy jobs are
  not a safe payload shape for compatibility authorization sent to nodes.
* There is no external-device entity, subscription bearer token, compatibility
  credential generation/A-B lifecycle, subscription gateway, or isolated client
  renderer set.
* RLS is generally deny-by-default on security-sensitive operational tables;
  service-role APIs implement ownership checks. New customer-facing state needs
  explicit RLS and privilege revocation rather than relying on API filtering.
* Security headers are strict and exercised in a real browser. A static build
  nonce remains weaker than a request nonce. Subscription responses need their
  own no-store/no-index/referrer policy and must never enter static caching.
* Retention exists for leases, jobs, traffic samples, revoked-device metadata,
  and alerts. Production scheduling, historical plaintext provisioning-URL
  purge, and credential rotation are operational actions requiring live access;
  repository scripts alone do not prove those actions occurred.

## Implementation direction

Phase 2 should add an external-device extension over the existing seat-bearing
`devices` row, a transactional database API for allocation/revocation, hashed
one-time subscription secrets, at-most-two encrypted compatibility credentials,
stable logical routes resolved at fetch time, a service-role-only desired-node
authorization projection containing opaque identifiers only, isolated renderer
modules with a deny-by-default capability matrix, and negative/security tests.
Native rolling authorization should remain on its existing lease-pool path and
be tightened rather than replaced.

