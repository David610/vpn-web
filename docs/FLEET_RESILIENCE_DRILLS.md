# Fleet resilience drills

Phase 14's remaining three activities (load, chaos/failure injection,
backup/restore) all need a real running fleet or a real Supabase project
to execute against — this document is the runbook and the tooling for
whoever has that access to actually run them. See
`docs/FLEET_LIFECYCLE_AUTOMATION.md` for what each piece of automation
referenced below is supposed to do.

Status: **NOT YET RUN**. Nothing in this document has been executed
against real infrastructure. Record results here (or link to where they're
recorded) once each drill has actually been run.

## Chaos / failure injection

`scripts/chaos-fleet.mjs` simulates the exact telemetry conditions Phase
8/12a/12b's automation reacts to (silence, a probe-failure streak) by
writing directly to `nodes` with the service-role key — the admin
lifecycle API can't do this, since `last_seen_at` and
`consecutive_probe_failures` are otherwise written only by a real node's
own heartbeat, and forcing a state directly through the admin API would
bypass detection entirely.

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
CHAOS_TARGET_NODE_ID=de-fsn-001 CHAOS_CONFIRM=de-fsn-001 \
node scripts/chaos-fleet.mjs silence
```

Run these against a staging project, never production, and never a node
currently carrying real customer traffic.

| Scenario | Simulates | Expected outcome |
|---|---|---|
| `silence` | agent process dead / network partition | node -> FAILED within one fleet-tick; with `FEATURE_AUTO_NODE_REPLACE` on, a REPLACE_NODE operation starts for it |
| `probe-failures` | node up but failing health checks (e.g. cert expired, sing-box wedged) | READY -> DEGRADED on its next heartbeat |
| `canary-abort` | a canary node going silent mid-observation | CANARY -> FAILED via `AWAIT_CANARY`; **the paired old node must never change state** — this is the single highest-value thing to verify for real, since it was a Critical finding fixed only under test mocks, never against a real fleet-tick |
| `watch` | (no injection) | prints the target node's state every poll interval — run in a second terminal, or after a real (not simulated) failure triggered by hand |

The gold-standard version of the `silence` drill is triggering the real
condition over SSH (`systemctl stop vpn-provisioning-agent` on a real
staging VPS) and using `watch` to observe recovery — that exercises the
actual network/heartbeat path this script's DB writes skip entirely.
Prefer that once staging access allows it; the script exists so the drill
is still possible without SSH access to a specific box.

Record here once run: date, scenario, node id, time-to-detect, time-to-
recover, any surprise.

## Backup / restore drill

1. Trigger a restore of a recent backup to a **new, separate** Supabase
   project (Dashboard -> Database -> Backups -> Restore, or
   `pg_restore`/`supabase db dump` for a self-managed target) — never
   restore over the live project.
2. Run the verification script against the restored database:

   ```bash
   psql "$RESTORED_DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify-fleet-backup-restore.sql
   ```

   It checks: every migration actually applied (not just a subset —
   verified via `nodes.lifecycle_state_changed_at` and the CANARY-inclusive
   `nodes_lifecycle_state_check`, both recent), referential integrity across
   `devices`/`vpn_accounts`/`device_profile_assignments`/`fleet_operations`/
   `operation_steps`/`nodes`, no null `lifecycle_state`, and flags (without
   failing) core tables landing empty, which usually means the wrong restore
   point was picked.
3. Time the restore itself (point-in-time-recovery duration, or dump/restore
   duration for a self-managed target) — this is the number that actually
   matters for an incident: how long until a fresh, verified database exists.
4. Tear down the restored project once verification is recorded — it's a
   second copy of real customer data and should not linger.

Record here once run: date, backup age at restore time, restore duration,
verification result, anything the script didn't catch that should have
been added to it.

## Load tests

The control-plane load test already exists and is documented in
`docs/PRODUCTION_SCALING.md` (`scripts/load-control-plane.mjs`) — run that
first; it hasn't changed.

What's new since that doc was written is real multi-node scheduling
(`FEATURE_MULTI_NODE_SCHEDULING`) and the fleet automation on top of it.
Two additions worth running once staging has more than one node:

- **Point `scripts/load-control-plane.mjs` at a fleet-aware endpoint**
  (e.g. `ENDPOINT=/api/vpn/config` with a device on a multi-node account)
  to confirm the scheduler's extra DB round-trips (candidate query, sticky
  lookup) don't blow the existing p95 <= 1500ms / <= 1% error-rate gate
  under the same 25/50/100/200/300-concurrency ramp already documented.
- **Trigger a capacity auto-scale under load**: with
  `FEATURE_AUTO_NODE_SCALE` on and a location's nodes deliberately capped
  low (`max_sessions`), drive enough concurrent device scheduling requests
  at that location to exhaust it, then confirm a CREATE_NODE operation
  actually starts within one fleet-tick and that in-flight nodes correctly
  suppress a second one piling up on the next tick.

The actual VPN **data-plane** load test (real sing-box tunnels, not just
control-plane API calls) still has no automation — `PRODUCTION_SCALING.md`
already documents this as a manual procedure ("run 25/50/100/200
concurrent tunnel load tests on the production-sized VPS and record CPU,
RAM, network, packet loss, latency, file descriptors, connection counts
and sing-box stability"). That guidance is unchanged by this fleet work;
it just hasn't been run yet, on a single node or a fleet.

Record here once run: date, concurrency levels, results against each gate,
any new bottleneck the fleet automation introduced.
