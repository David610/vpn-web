# Fleet Phase 12b: Canary Rollout for Node Replacement

Status: approved design, pending implementation plan
Repo affected: `vpn-web` (control plane) only — no `singbox-vpn` agent changes.
Corresponds to: `docs/FLEET_PLATFORM_PLAN.md` Phase 12 ("Replace-node
workflow, canary rollout states, capacity-aware scheduling refinement"),
second of three sub-projects this phase is decomposed into. Builds directly
on Phase 12a (replace-node workflow, `docs/superpowers/specs/2026-09-25-
fleet-phase12a-replace-node-design.md`, shipped as vpn-web PR #35).
Capacity-aware scheduling refinement (Phase 12c) is a separate, later spec.

## 1. Problem

Phase 12a's `REPLACE_NODE` operation trusts a new node completely the
instant it reaches `READY`: `functions/lib/scheduler.js`'s candidate
queries filter on `lifecycle_state = 'READY'` only, and `selectNodeForDevice`
always prefers the least-loaded candidate — so a freshly-provisioned node,
starting at zero sessions, immediately wins nearly every new placement
decision the moment it's marked `READY`. Nothing observes it under real
traffic before it absorbs a large share of new devices. Phase 12a's own
follow-up note anticipated this: "a canary is just a replace-node done
cautiously."

## 2. Goals

- Let a replacement optionally hold the new node to a small, capped share
  of real traffic for an observation window before trusting it fully,
  reusing Phase 8's existing synthetic health probes as the promotion
  signal.
- If the node fails health checks during that window, abort the
  replacement without ever touching the old node — extending 12a's
  existing "old node untouched until the new node is proven" principle
  from "reached READY" to "survived the canary window healthy."
- Change nothing about 12a's already-shipped, already-reviewed default
  behavior: canary is strictly opt-in.

## 3. Non-goals (deferred)

- Per-request-configurable observation windows or session caps — fixed
  constants for this increment.
- A dedicated admin UI indicator for canary status — the existing Jobs
  view already surfaces `fleet_operations` rows generically, including
  their `detail`/`status`.
- Canary for `CREATE_NODE` (a brand-new fleet node with no predecessor to
  protect) — this phase is replacement-only.
- Capacity-aware scheduling refinement generally — Phase 12c.

## 4. Design

### 4.1 Lifecycle state (`node-lifecycle.js`)

A new state, `CANARY`, added to `NODE_LIFECYCLE_STATES`. New edges in
`ALLOWED_TRANSITIONS`:

- `WARMING_UP -> CANARY` (replacing `WARMING_UP -> READY` as the outcome
  of a canary-mode `MARK_READY`, alongside the existing `WARMING_UP ->
  READY` edge, which non-canary replacements and all `CREATE_NODE`
  operations keep using unchanged).
- `CANARY -> READY` (promotion after a healthy observation window).
- `CANARY -> FAILED` (abort — probe failures crossed the threshold during
  the window).

A DB migration widens `nodes.lifecycle_state`'s existing `CHECK` constraint
(`fleet_foundations.sql`) to include `'CANARY'`.

### 4.2 Saga changes (`fleet-operations.js`)

`op.detail.canary: boolean`, default `false`, set once at operation
creation (mirrors how `oldNodeId`/`maxWaitHours` already travel in
`detail`). `REPLACE_NODE_STEPS` gains a new step, `AWAIT_CANARY`, inserted
between `MARK_READY` and `DRAIN_OLD_NODE` — present in the step list
unconditionally (so the step-index/ordering machinery stays simple), but a
no-op that immediately completes when `detail.canary` is `false`.

**`MARK_READY` (canary-aware):** when `detail.canary` is `true`, transitions
the node `WARMING_UP -> CANARY` instead of `WARMING_UP -> READY`, setting
`lifecycle_state_changed_at` as every lifecycle write already must. When
`detail.canary` is `false`, behavior is completely unchanged from Phase 12a
— existing tests for the non-canary path continue to hold verbatim.

**`AWAIT_CANARY`:**
- If `detail.canary` is `false` or the node's `lifecycle_state` is already
  `READY` (non-canary path, or a resumed operation past this point):
  `done()` immediately, no-op.
- Otherwise, reads the node's `consecutive_probe_failures` (written by
  Phase 8's existing heartbeat path, `node-health-transition.js`'s
  `evaluateProbeResult` — already runs for every node regardless of
  lifecycle state; a `CANARY` node simply isn't in that function's own
  automation-eligible-state list, so it updates the streak columns but
  never acts on them itself, leaving this step as the sole consumer for
  `CANARY` nodes).
  - **Abort:** if `consecutive_probe_failures >= FAILURE_THRESHOLD`
    (Phase 8's existing constant, `3`), compare-and-set the node
    `CANARY -> FAILED` and raise `FatalStepError`. The operation ends
    `FAILED`; the canary node is `FAILED` (eligible for its own future
    auto-replacement later, same as any other `FAILED` node); the **old
    node is never touched** — it was never transitioned to `DRAINING`,
    since that only happens in `DRAIN_OLD_NODE`, which this step precedes.
  - **Promote:** once `now() - lifecycle_state_changed_at >=
    CANARY_OBSERVATION_MS` and the node is not currently failing (the
    abort check above didn't fire this tick), compare-and-set
    `CANARY -> READY`, then `done()` — falls through to `DRAIN_OLD_NODE`
    exactly as the non-canary path already does.
  - **Otherwise:** `wait()` one poll cycle (reusing `DRAIN_POLL_INTERVAL_S`
    from 12a — no new polling constant needed).
- A node with no probe capability (`probeOk` always `null`, per Phase 8)
  can never hit the abort path (`consecutive_probe_failures` never
  increments for it) — it promotes on the window elapsing alone, the same
  treatment Phase 8 gives null-probe nodes elsewhere.

### 4.3 Scheduler change (`scheduler.js`)

All three scheduling functions (`scheduleNodeForDevice`,
`scheduleDoubleHopForDevice`, `scheduleAutoForDevice`) change their nodes
query from `.eq("lifecycle_state", "READY")` to
`.in("lifecycle_state", ["READY", "CANARY"])`. In the JS candidate-mapping
layer, a `CANARY` node's effective cap becomes
`Math.min(node.max_sessions ?? Infinity, CANARY_SESSION_CAP)` — the
existing `isUnderCapacity()` filter and `selectNodeForDevice()`'s
least-loaded/sticky logic are otherwise completely unchanged; the low cap
alone makes a canary node naturally stop being selected once full, with no
new selection algorithm, probability, or weighting logic.

### 4.4 Trigger

`POST /api/admin/nodes/:id/replace` gains an optional `canary: true` body
field, default `false`. `startReplaceNodeOperation`'s options gain a
matching `canary` parameter, threaded into `op.detail.canary` via the
existing `p_detail` RPC argument (same mechanism `provider`/`region`
already use — no RPC signature change needed, `p_detail` is already an
opaque `jsonb` merge point).

The auto-trigger (`node-auto-replace.js`) gets its own flag,
`FEATURE_AUTO_NODE_REPLACE_CANARY`, default off, checked alongside the
existing `FEATURE_AUTO_NODE_REPLACE` gate — when both are `"true"`,
auto-triggered replacements pass `canary: true`; otherwise they keep
Phase 12a's shipped immediate-trust behavior unchanged.

### 4.5 Constants

```js
export const CANARY_OBSERVATION_MS = 2 * 60 * 60 * 1000; // 2 hours
export const CANARY_SESSION_CAP = 10;
```

Both fixed for this increment (§3 non-goals). `FAILURE_THRESHOLD` (abort
trigger) and `DRAIN_POLL_INTERVAL_S` (poll cadence) are reused from
existing Phase 8/12a code, not redefined.

### 4.6 Observability

No new mechanism. The admin Jobs view already lists `fleet_operations`
regardless of `type`/`detail` shape, so a canary-mode operation's `CANARY`
step and its outcome are visible there the same way `DRAIN_OLD_NODE`'s
progress already is. An aborted canary produces the same `node_failed`
alert path Phase 8 already raises for any node entering `FAILED`.

## 5. Testing

- Unit tests for `AWAIT_CANARY`: non-canary no-op, promote-after-window,
  abort-on-failure-streak, still-waiting mid-window, no-probe-capability
  promotes on window alone.
- Unit test confirming `MARK_READY`'s non-canary path is byte-for-byte
  unchanged from Phase 12a (regression guard against the canary-aware
  branch leaking into the default path).
- Scheduler tests: a `CANARY` node is selected under its cap, stops being
  selected once its capped session count is reached, and a `READY` node's
  behavior is completely unaffected by the new `CANARY` branch existing.
- Regression test: a full non-canary `REPLACE_NODE` operation (Phase 12a's
  existing test suite) produces identical results with the new
  `AWAIT_CANARY` step present but no-opped.

## 6. Open follow-ups (not blocking this increment)

- Configurable per-request observation window/session cap, if the fixed
  defaults prove wrong in practice.
- Admin UI surfacing canary status explicitly, rather than via the generic
  Jobs view.
- Phase 12c: capacity-aware scheduling refinement generally.
