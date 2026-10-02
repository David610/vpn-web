# Arcana data-plane contract fixtures

Canonical, identity-free examples of `GET /api/agent/authorizations`. The
`singbox-vpn` repository should consume these files in contract tests rather
than inventing a second payload. `active.json`, `overlap.json`, `revoked.json`,
and `empty.json` are valid snapshots. Files prefixed `invalid-` are negative
security fixtures and **must** be rejected (the example leaks control-plane
identity). Bearer subscription tokens are never part of this contract.
