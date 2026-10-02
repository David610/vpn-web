# Arcana data-plane authorization contract fixtures

These fixtures are explicitly versioned; there is no single unversioned
cross-repository shape during rollout.

- `legacy-active.json` and `legacy-revoked.json` describe the frozen response
  from unversioned `GET /api/agent/authorizations`. Legacy entries include
  `logical_route_id`.
- `v2-active.json`, `v2-overlap.json`, and `v2-empty.json` describe
  `GET /api/agent/authorizations?schema=2`. V2 adds `schema_version` and the
  node-scoped `snapshot_revision`, including revision 0 for the initial empty
  snapshot, and deliberately omits logical-route and customer metadata.
- `invalid-identity-leak.json` is a negative security fixture and must be
  rejected because it contains control-plane identity.

The `singbox-vpn` repository should consume both legacy and v2 fixtures in its
transition contract tests. No response may contain account, customer, billing,
or subscription-token data.
