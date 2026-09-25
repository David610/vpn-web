# Fleet Phase 12a: Replace-Node Workflow

Status: approved design, pending implementation plan
Repo affected: `vpn-web` (control plane) only — no `singbox-vpn` agent changes.
Corresponds to: `docs/FLEET_PLATFORM_PLAN.md` Phase 12 ("Replace-node
workflow, canary rollout states, capacity-aware scheduling refinement"),
first of three sub-projects this phase is decomposed into. Canary rollout
and capacity-aware scheduling refinement are separate follow-up specs.

## 1. Problem

There is no safe, automatable way to retire a bad node and stand up its
replacement today. An admin who wants to replace a node must, by hand:
create a new node (`POST /api/admin/nodes`), wait for it to become `READY`,
manually flip the old node through `DRAINING`/`RETIRED`
(`PATCH /api/admin/nodes/:id/lifecycle`), and separately tear down its
provider instance — with no coordination, no idempotency across a lost
request, and no guarantee the new node is actually healthy before the old
one stops serving.

Phase 8 (synthetic health probes, hysteresis, passive failover) gives us
automatic `FAILED` detection but explicitly stopped short of doing anything
about it beyond alerting — this phase closes that loop for the "replace the
bad node" case.

## 2. Goals

- Let an admin trigger "replace this node" as a single action that
  provisions a fresh node, safely migrates devices off the old one, and
  retires it — reusing the existing `fleet_operations` saga engine rather
  than building new orchestration.
- Never drop capacity: the old node keeps serving until the new node is
  independently verified `READY`.
- Bound the whole workflow in time even if devices never reconnect on
  their own (an uninstalled app, a permanently offline device).
- Lay the groundwork so a sustained `FAILED` node can (once enabled)
  trigger this automatically, without a human noticing first.

## 3. Non-goals (deferred)

- Canary rollout states — separate follow-up spec (Phase 12b).
- Capacity-aware scheduling refinement — separate follow-up spec (Phase 12c).
- Active eviction / forced client reconnect — still out of scope, same as
  Phase 8; migration off the old node stays passive.
- Batch/simultaneous replacement of multiple nodes.
- Any `singbox-vpn` agent-side change — this phase is entirely control-plane
  orchestration of existing primitives (provider adapter, scheduler,
  lifecycle state machine).

## 4. Design

### 4.1 Operation shape (`functions/lib/fleet-operations.js`)

A new operation type, `REPLACE_NODE`, added to the existing saga engine
alongside `CREATE_NODE`. `op.node_id` is the **new** node being created —
this lets the six existing `CREATE_NODE_HANDLERS`
(`CREATE_INSTANCE`, `PUBLISH_DNS`, `AWAIT_ENROLLMENT`, `AWAIT_BOOTSTRAP`,
`VERIFY_READINESS`, `MARK_READY`) run completely unmodified against it,
since `advanceOperation()`'s `loadNode()` always loads `op.node_id`. The
old node being replaced is carried in `op.detail.oldNodeId`, set once at
operation creation and read directly by the two new step handlers (they
load it themselves rather than via the generic `loadNode()`, which only
ever targets `op.node_id`).

```js
export const REPLACE_NODE_STEPS = [
  ...CREATE_NODE_STEPS, // CREATE_INSTANCE .. MARK_READY, unmodified
  "DRAIN_OLD_NODE",
  "RETIRE_OLD_NODE",
];
```

`REPLACE_NODE_HANDLERS` reuses every `CREATE_NODE_HANDLERS` entry by
reference for the first six steps, plus:

**`DRAIN_OLD_NODE`:**
- On first entry (no `detail.drainDeadline` recorded yet on this step),
  compare-and-set the old node from its current state (`READY` or
  `DEGRADED` — see §4.2 for why `FAILED` is handled differently) to
  `DRAINING`, and compute `drainDeadline = now + maxWaitHours` (from
  `op.detail.maxWaitHours`, set at operation creation — default value in
  §4.4), persisting it into the step's `detail` so it survives a crashed
  Worker invocation or lost lease.
- Every entry after that: count `device_node_assignments` rows (any `hop`)
  referencing the old node. `done()` once the count is zero, or once
  `now() > detail.drainDeadline` (force through — a device that never
  reconnects must not block retirement forever). Otherwise
  `wait(DRAIN_POLL_INTERVAL_S, { remaining: count, drainDeadline })`.
- If the compare-and-set fails (old node already left the expected state —
  e.g. an admin manually quarantined it mid-replacement), this is a
  `FatalStepError`: the replacement operation cannot safely continue past a
  node whose state changed out from under it. The new node it already
  created stays `READY` and simply becomes a normal fleet member; nothing
  about it depends on the old node's fate. This is a deliberate difference
  from `CREATE_NODE`'s failure handling: there is no node to roll back to
  `FAILED` here, because a `REPLACE_NODE` failure past `MARK_READY` is a
  failure to *retire the old node*, not a failure to create the new one.

**`RETIRE_OLD_NODE`:**
- Compare-and-set the old node `DRAINING → RETIRED`, set `retired_at`
  (matching the admin-lifecycle route's existing convention).
- Call `adapter.destroyInstance({ providerInstanceId })` — already built
  (`functions/lib/provider-adapter.js`, idempotent, treats 404 as success)
  but never wired into any operation until now.
- If the compare-and-set fails (old node already left `DRAINING` somehow),
  treat as `done()` without calling `destroyInstance` again — idempotent
  by design, matching every other step handler's adopt-existing-effect
  pattern.

### 4.2 Why `FAILED` needs its own drain path

A `FAILED` old node being replaced is very likely the node that triggered
this replacement in the first place (see §4.4) — it may not be
heartbeating at all, meaning `device_node_assignments` rows referencing it
could sit forever if we required active confirmation. `DRAIN_OLD_NODE`'s
first-entry transition therefore accepts `FAILED` as a starting state too
(`FAILED → DRAINING`, a transition `ALLOWED_TRANSITIONS` does not currently
have — Task 1 of the implementation plan adds it), and the same
zero-assignments-or-timeout logic applies unchanged: a `FAILED` node's
devices reconnect elsewhere via the scheduler's normal
`lifecycle_state = READY` filtering exactly like a `DEGRADED` node's do,
whether or not the old node itself is still reachable.

### 4.3 Eligibility and concurrency

Replacement may only be started (admin or auto) when the old node is
`READY`, `DEGRADED`, or `FAILED`. `QUARANTINED` is excluded deliberately —
it remains a one-way security containment (spec §45 precedent from Phase 8)
whose only exit is manual `RETIRED`, never an automated drain path.
`PROVISIONING`, `WARMING_UP`, `DRAINING`, `MAINTENANCE`, and `RETIRED` are
excluded because there is either nothing to replace yet or a transition
already in flight.

Concurrency is enforced the same way `CREATE_NODE` already prevents
duplicate operations: `idempotency_key = "REPLACE_NODE:" || oldNodeId`,
unique-constrained at the database level (existing
`fleet_operations_idempotency_key_key` constraint, no migration needed). A
second attempt to replace a node that already has an in-flight
`REPLACE_NODE` operation fails cleanly on insert, exactly like a duplicate
`CREATE_NODE` request does today.

**Ordering is the safety net:** the old node is never touched until the new
node reaches `MARK_READY`. If new-node provisioning fails at any step
before that (the existing `CREATE_NODE_HANDLERS` failure/retry/deadline
logic in `advanceOperation()`, unchanged), the old node is never
transitioned and keeps serving traffic — capacity is never dropped ahead of
a working replacement.

### 4.4 Triggers

**Admin-initiated:** new route `POST /api/admin/nodes/:id/replace`
(`functions/api/admin/nodes/[id]/replace.js`), parallel in shape to the
existing `POST /api/admin/nodes` (create) route. Validates the target node
is in an eligible state (§4.3), mints a new node id/hostname the same way
node creation does today, and calls a new `startReplaceNodeOperation()`
(parallel to the existing `startCreateNodeOperation()` in
`fleet-operations.js`) which atomically inserts the new `PROVISIONING` node
row, the `REPLACE_NODE` operation row (with `detail.oldNodeId` and
`detail.maxWaitHours`), and its `operation_steps` rows — same
`register_node_create_operation()`-style RPC pattern, a new
`register_node_replace_operation()` RPC added by migration. Request body
accepts an optional `maxWaitHours` override; default `72` (3 days —
generous enough to cover a device that only reconnects on its next natural
app-restart cycle, per the Phase 8 spec's own passive-drain latency
reasoning).

**Auto-triggered (`FEATURE_AUTO_NODE_REPLACE`, default off):** `fleet-tick`
(`functions/api/internal/fleet-tick.js`) gains one additional check per
invocation, after leasing due operations: query nodes where
`lifecycle_state = 'FAILED'` continuously longer than
`AUTO_REPLACE_AFTER_FAILED_MS` (new env var, no built-in default — must be
explicitly configured, since "continuously" requires reading
`nodes.lifecycle_state` alongside a transition timestamp column this phase
adds — see §4.5) and with no existing `REPLACE_NODE` operation for them
(checked via the same idempotency key, queried directly rather than
attempted-and-caught, to avoid a noisy unique-violation on every tick for a
node already mid-replacement). Each match calls
`startReplaceNodeOperation()` the same way the admin route does. This
composes with Phase 8: a silently-dead node auto-fails (Phase 8's
silence-detection), then — once this flag is enabled — auto-replaces.

### 4.5 Schema

New additive migration:

```sql
alter table nodes
  add column lifecycle_state_changed_at timestamptz;

-- Backfill: treat existing rows as having just changed, so the auto-replace
-- check (which requires a node to have been FAILED continuously for a
-- configured duration) never fires spuriously on old data on first deploy.
update nodes set lifecycle_state_changed_at = now();

alter table nodes
  alter column lifecycle_state_changed_at set not null,
  alter column lifecycle_state_changed_at set default now();
```

Every write to `nodes.lifecycle_state` (admin lifecycle route, Phase 8's
`node-health-transition.js` paths, `fleet-operations.js`'s `MARK_READY` and
`failNodeIfBooting`, and the new `DRAIN_OLD_NODE`/`RETIRE_OLD_NODE`
handlers) sets `lifecycle_state_changed_at = now()` in the same update —
one column, one convention, reused everywhere a transition already writes
`lifecycle_state`. This is intentionally a general-purpose column (not
"failed_at" or similar) so it is available to future phases too, e.g. the
`failed_reason` hard-precondition Phase 8's spec flagged as unresolved
could eventually pair with it.

New RPC `register_node_replace_operation()`, mirroring
`register_node_create_operation()`: takes the new node's id/role/location/
provider/hostname, the old node's id, `maxWaitHours`, and the step list;
inserts the new `PROVISIONING` node row, the `REPLACE_NODE` fleet_operations
row (`detail = { oldNodeId, maxWaitHours }`), and its ordered
`operation_steps` rows atomically — same transactional shape as the
existing function.

### 4.6 Observability

No new mechanism. The existing admin Jobs view already lists
`fleet_operations` rows regardless of `type`, so `REPLACE_NODE` operations
appear there automatically once the migration and route ship. Triggering a
replacement writes an admin audit entry,
`admin.node_replace_initiated` (`{ oldNodeId, newNodeId }` metadata),
mirroring `admin.node_lifecycle_transition`'s existing shape. No new alert
type — Phase 8's existing `node_failed`/recovery alerts already cover the
old node's health signal; this phase only adds what happens in response.

### 4.7 Rollout

The admin-initiated path ships unconditionally — it is an explicit, opt-in
admin action with no ambient risk, same trust level as the existing manual
lifecycle PATCH route it replaces. The **auto-triggered** path only is
gated behind `FEATURE_AUTO_NODE_REPLACE`, defaulting off, following the
same pattern as `FEATURE_AUTO_NODE_HEALTH` (Phase 8) and
`FEATURE_MULTI_NODE_SCHEDULING`. Enabled first in staging against a real
`FAILED` node before production rollout, per the fleet plan's standing
requirement that data-plane claims be verified against real infrastructure.

## 5. Testing

- Unit tests for `DRAIN_OLD_NODE` and `RETIRE_OLD_NODE`, mirroring the
  existing `CREATE_NODE_HANDLERS` test style in
  `functions/lib/__tests__/fleet-operations.test.js`:
  - Happy path: `READY` old node → `DRAINING` → zero assignments → `RETIRED`,
    `destroyInstance` called once.
  - New-node provisioning failure (any of the six reused steps) leaves the
    old node's `lifecycle_state` completely untouched — asserted by
    checking the old node row is unchanged after a failed operation.
  - Drain resolves by zero-assignments before the deadline.
  - Drain forces through at `drainDeadline` with assignments still present.
  - `FAILED` old node accepted as a starting state for `DRAIN_OLD_NODE`.
  - `destroyInstance` 404-as-success path (mock adapter, matches existing
    `providers/mock.js`/`hetzner.js` test coverage).
  - Duplicate `REPLACE_NODE` for the same old node rejected via the unique
    idempotency key.
  - `QUARANTINED` old node rejected by the admin route before any operation
    is created.
- Regression test confirming `lifecycle_state_changed_at` is set on every
  existing write path that touches `lifecycle_state` (admin lifecycle
  route, Phase 8 transition paths, `MARK_READY`, `failNodeIfBooting`) — a
  missed call site would silently break the auto-replace duration check.
- Scripted staging integration check against one real node (same pattern as
  Phase 8's §5): trigger a manual replace on a real `READY` node, confirm
  the new node reaches `READY`, the old node reaches `DRAINING` then
  `RETIRED`, and the provider instance is actually gone.

## 6. Open follow-ups (not blocking this increment)

- Phase 12b: canary rollout states (a replacement that only takes a small
  fraction of new traffic before being trusted with the rest) — this phase
  deliberately treats the new node as fully trusted the instant it's
  `READY`, same as `CREATE_NODE` always has.
- Phase 12c: capacity-aware scheduling refinement.
- Surfacing `lifecycle_state_changed_at` explicitly in the admin Fleet UI
  (currently only used internally by the auto-replace check).
