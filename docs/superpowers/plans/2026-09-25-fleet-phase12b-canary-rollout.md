# Fleet Phase 12b: Canary Rollout for Node Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a node replacement optionally hold the new node to a capped share of real traffic for an observation window before trusting it fully, aborting (with the old node left untouched) if health probes fail during that window.

**Architecture:** A new `CANARY` lifecycle state sits between `WARMING_UP` and `READY` in the `REPLACE_NODE` saga only. A new `AWAIT_CANARY` step reads the same probe-streak columns Phase 8 already maintains on every heartbeat to decide promote/abort. The scheduler includes `CANARY` nodes in its candidate pool but caps their effective session limit, reusing its existing capacity filter unchanged.

**Tech Stack:** Cloudflare Pages Functions (JS), Supabase/Postgres migrations, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-fleet-phase12b-canary-rollout-design.md`

## Global Constraints

- Canary is opt-in only: `detail.canary` defaults to `false`/absent, and every existing non-canary code path (including all of Phase 12a's already-shipped behavior) must be byte-for-byte unaffected.
- `CANARY -> FAILED` aborts once `consecutive_probe_failures >= FAILURE_THRESHOLD` (Phase 8's existing constant, `3`, imported from `node-health-transition.js` — not redefined).
- `CANARY -> READY` promotes once `now() - lifecycle_state_changed_at >= CANARY_OBSERVATION_MS` (`2 * 60 * 60 * 1000`, new constant) and the node is not currently over the failure threshold.
- On abort, the **old node is never touched** — `DRAIN_OLD_NODE` runs after `AWAIT_CANARY` in the step order, so an abort never reaches it.
- Scheduler: a `CANARY` node's effective session cap is `Math.min(node.max_sessions ?? Infinity, CANARY_SESSION_CAP)` (`10`, new constant) — reuses the existing `isUnderCapacity()`/least-loaded logic unchanged, no new selection algorithm.
- A node with no probe capability (`probeOk` always `null`) can never hit the abort path — it promotes on the window elapsing alone.

## Review Focus

- **A canary node that never receives any real traffic during its window** (e.g. a quiet region): must still promote on the window elapsing via probe streak alone — pinned by Task 2's no-probe-capability test.
- **A resumed operation retrying `AWAIT_CANARY` after the node is already `READY`** (a crash between the promotion write and the step being marked `COMPLETED`): must not re-attempt a `CANARY -> READY` transition and fail — pinned by Task 2's idempotency test.
- **A non-canary `REPLACE_NODE` operation must produce identical behavior to Phase 12a**, with `AWAIT_CANARY` and the canary-aware `MARK_READY` branch both no-opping — pinned by Task 2's regression test.
- **A `CANARY` node that hits its session cap must stop being selected**, not error or silently ignore the cap — pinned by Task 3's tests across all three scheduling functions.
- **An admin quarantining the new node mid-canary** (between `MARK_READY`'s `CANARY` write and `AWAIT_CANARY`'s next tick): must fail loudly, not silently overwrite the admin action — pinned by Task 2's concurrent-state-change test, mirroring `DRAIN_OLD_NODE`'s existing pattern for the same scenario on the old node.

---

### Task 1: CANARY lifecycle state

**Files:**
- Modify: `functions/lib/node-lifecycle.js`
- Create: `supabase/migrations/20260927000000_canary_lifecycle_state.sql`
- Test: `functions/lib/__tests__/node-lifecycle.test.js`

**Interfaces:**
- Produces: `"CANARY"` added to `NODE_LIFECYCLE_STATES`; `canTransitionLifecycle("WARMING_UP", "CANARY")`, `canTransitionLifecycle("CANARY", "READY")`, and `canTransitionLifecycle("CANARY", "FAILED")` all return `true`.

- [ ] **Step 1: Write the failing tests**

Add to `functions/lib/__tests__/node-lifecycle.test.js`:

```js
it("allows WARMING_UP to CANARY (Phase 12b canary-mode replacement)", () => {
  expect(canTransitionLifecycle("WARMING_UP", "CANARY")).toBe(true);
});

it("allows CANARY to READY (canary promotion)", () => {
  expect(canTransitionLifecycle("CANARY", "READY")).toBe(true);
});

it("allows CANARY to FAILED (canary abort)", () => {
  expect(canTransitionLifecycle("CANARY", "FAILED")).toBe(true);
});

it("includes CANARY in the valid state list", () => {
  expect(isValidLifecycleState("CANARY")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- node-lifecycle`
Expected: FAIL — `CANARY` is not a recognized state, all four new assertions fail.

- [ ] **Step 3: Add CANARY to node-lifecycle.js**

In `functions/lib/node-lifecycle.js`, add `"CANARY"` to `NODE_LIFECYCLE_STATES` (after `"WARMING_UP"`, before `"READY"`, matching the conceptual ordering described in the spec):

```js
export const NODE_LIFECYCLE_STATES = Object.freeze([
  "PROVISIONING",
  "WARMING_UP",
  "CANARY",
  "READY",
  "DEGRADED",
  "DRAINING",
  "MAINTENANCE",
  "FAILED",
  "QUARANTINED",
  "RETIRED",
]);
```

Change the `WARMING_UP` entry (currently `WARMING_UP: ["READY", "FAILED", "QUARANTINED"],`) to add `"CANARY"`:

```js
  WARMING_UP: ["READY", "CANARY", "FAILED", "QUARANTINED"],
```

Add a new `CANARY` entry, right after `WARMING_UP`'s entry:

```js
  // Phase 12b canary-mode replacement: a node marked CANARY instead of
  // READY by fleet-operations.js's canary-aware MARK_READY is observed
  // under a capped share of real traffic (scheduler.js) before promotion.
  // AWAIT_CANARY (fleet-operations.js) is the only writer of either edge.
  CANARY: ["READY", "FAILED"],
```

Update the file's header comment (after the existing "Phase 12a added
FAILED->DRAINING" sentence) to mention this addition:

```js
 * Phase 8 added the health-based edges READY<->DEGRADED, READY->FAILED,
 * DEGRADED->FAILED and FAILED->READY. Phase 12a added FAILED->DRAINING (a
 * FAILED node can be replaced, same as a READY or DEGRADED one). Phase 12b
 * added the CANARY state (WARMING_UP->CANARY, CANARY->READY,
 * CANARY->FAILED) for canary-mode replacement. Automation does NOT get
 * everything this table allows: functions/lib/node-health-transition.js
 * and functions/lib/fleet-operations.js's REPLACE_NODE handlers each spell
 * out their own narrower set of automated moves, using canTransitionLifecycle
 * only as a secondary guard.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- node-lifecycle`
Expected: PASS.

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/20260927000000_canary_lifecycle_state.sql`:

```sql
-- Fleet Phase 12b: canary rollout for node replacement.
--
-- nodes.lifecycle_state's CHECK constraint (fleet_foundations.sql) enumerates
-- every allowed value explicitly; CANARY needs to be added to it before any
-- row can actually be written with that value. Postgres has no ALTER TABLE
-- ... ALTER CONSTRAINT for a CHECK's expression -- the existing constraint
-- must be dropped and recreated with the wider list.
alter table public.nodes
  drop constraint nodes_lifecycle_state_check;

alter table public.nodes
  add constraint nodes_lifecycle_state_check check (
    lifecycle_state in (
      'PROVISIONING', 'WARMING_UP', 'CANARY', 'READY', 'DEGRADED',
      'DRAINING', 'MAINTENANCE', 'FAILED', 'QUARANTINED', 'RETIRED'
    )
  );
```

Note: the constraint's actual generated name may differ from
`nodes_lifecycle_state_check` (Postgres auto-names unnamed column-level
`CHECK` constraints as `<table>_<column>_check` by default, which matches
here, but confirm against the live schema if this migration is ever run
against a database — `\d nodes` in `psql`, or Supabase's dashboard schema
view, will show the actual constraint name if it differs).

- [ ] **Step 6: Commit**

```bash
git add functions/lib/node-lifecycle.js functions/lib/__tests__/node-lifecycle.test.js supabase/migrations/20260927000000_canary_lifecycle_state.sql
git commit -m "feat(fleet): Phase 12b CANARY lifecycle state"
```

---

### Task 2: AWAIT_CANARY saga step

**Files:**
- Modify: `functions/lib/fleet-operations.js`
- Test: `functions/lib/__tests__/fleet-operations.test.js`

**Interfaces:**
- Consumes: `FAILURE_THRESHOLD` (import from `./node-health-transition.js`, existing export, value `3`); `canTransitionLifecycle`, `updateNode`, `FatalStepError`, `done`, `wait`, `DRAIN_POLL_INTERVAL_S` (all already in this file).
- Produces: `CANARY_OBSERVATION_MS` (`2 * 60 * 60 * 1000`), `CANARY_SESSION_CAP` (`10`) — both new exports, consumed by Task 3. `REPLACE_NODE_STEPS` gains `"AWAIT_CANARY"` between `"MARK_READY"` and `"DRAIN_OLD_NODE"`. `startReplaceNodeOperation`'s options gain an optional `canary` field (default `false`), threaded into `op.detail.canary`.

- [ ] **Step 1: Write the failing tests**

Add to `functions/lib/__tests__/fleet-operations.test.js`. First, extend the
`replaceSeed()` helper (added in Phase 12a) to accept a `canary` flag and
seed the node's probe columns, and add a canary-driving helper:

```js
function replaceSeed({ oldState = "READY", canary = false } = {}) {
  const base = seed();
  base.nodes[0].consecutive_probe_failures = 0;
  base.nodes.push({
    node_id: OLD_NODE_ID,
    role: "EXIT",
    lifecycle_state: oldState,
    provider: "hetzner",
    provider_instance_id: "old-instance-1",
    ip_address: "198.51.100.1",
  });
  base.fleet_operations[0].type = "REPLACE_NODE";
  base.fleet_operations[0].detail = { provider: "hetzner", region: "fsn1", oldNodeId: OLD_NODE_ID, maxWaitHours: 72, canary };
  base.operation_steps = REPLACE_NODE_STEPS.map((name, i) => ({
    id: i + 1,
    operation_id: "op-1",
    step_index: i,
    name,
    status: "PENDING",
    attempts: 0,
    detail: {},
  }));
  base.device_node_assignments = [];
  return base;
}
```

(This replaces the plan-12a-era `replaceSeed()` — the `oldState` parameter
and existing shape are preserved, only the `canary` flag and the new
node's `consecutive_probe_failures` seed column are added. Update the
import line to also pull in `REPLACE_NODE_STEPS` if not already imported —
Phase 12a's Task 3 already added this import, so it should already be
present; if the file doesn't have it, add
`REPLACE_NODE_STEPS,` to the existing `from "../fleet-operations.js"` import.)

Now the tests, added to the existing `describe("REPLACE_NODE operation", ...)` block:

```js
it("non-canary MARK_READY is unaffected: goes straight to READY, AWAIT_CANARY no-ops", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: false }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  expect((await node()).lifecycle_state).toBe("READY");
  // AWAIT_CANARY must have completed within the same cascade as MARK_READY
  // (it's a no-op for non-canary), landing straight on DRAIN_OLD_NODE's
  // first entry -- same observable behavior as before this task existed.
  const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
  expect(old.lifecycle_state).toBe("DRAINING");
});

it("canary mode: MARK_READY marks the node CANARY, not READY", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  expect((await node()).lifecycle_state).toBe("CANARY");
  // The old node must be completely untouched -- DRAIN_OLD_NODE has not
  // run, since AWAIT_CANARY is still waiting out the observation window.
  const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
  expect(old.lifecycle_state).toBe(oldState_READY_default());
});

function oldState_READY_default() {
  return "READY";
}

it("canary mode: promotes to READY once the observation window has elapsed with no failures", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  expect((await node()).lifecycle_state).toBe("CANARY");

  // Force the CANARY entry timestamp into the past instead of waiting real time.
  await setNode({ lifecycle_state_changed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });

  const result = await advance();
  expect(result).toMatchObject({ step: "DRAIN_OLD_NODE", status: "RUNNING" });
  expect((await node()).lifecycle_state).toBe("READY");
});

it("canary mode: aborts to FAILED once probe failures cross the threshold, old node untouched", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  expect((await node()).lifecycle_state).toBe("CANARY");

  await setNode({ consecutive_probe_failures: 3 });

  const result = await advance();
  expect(result.status).toBe("FAILED");
  expect((await node()).lifecycle_state).toBe("FAILED");
  const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
  expect(old.lifecycle_state).toBe("READY"); // never touched
});

it("canary mode: a node with no probe capability (consecutive_probe_failures never set) still promotes on the window alone", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  await setNode({ lifecycle_state_changed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), consecutive_probe_failures: null });

  const result = await advance();
  expect(result).toMatchObject({ step: "DRAIN_OLD_NODE", status: "RUNNING" });
  expect((await node()).lifecycle_state).toBe("READY");
});

it("canary mode: still waiting mid-window, below the failure threshold", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  await setNode({ consecutive_probe_failures: 2 }); // below FAILURE_THRESHOLD (3)

  const result = await advance();
  expect(result).toMatchObject({ step: "AWAIT_CANARY", status: "RUNNING" });
  expect((await node()).lifecycle_state).toBe("CANARY");
});

it("canary mode: fails loudly, not silently, if the new node's state changed concurrently (e.g. an admin quarantined it)", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  await setNode({ lifecycle_state: "QUARANTINED" });

  const result = await advance();
  expect(result.status).toBe("FAILED");
  const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
  expect(old.lifecycle_state).toBe("READY"); // never touched
});

it("canary mode: idempotent -- resuming AWAIT_CANARY after the node already reached READY does not re-attempt the transition", async () => {
  db = makeFakeSupabase(replaceSeed({ canary: true }));
  ctx.supabase = db;
  await driveNewNodeToReady();
  await setNode({ lifecycle_state: "READY" }); // simulate a prior tick's promotion that already committed

  const result = await advance();
  expect(result).toMatchObject({ step: "DRAIN_OLD_NODE", status: "RUNNING" });
});
```

Also add a `startReplaceNodeOperation` unit test (new `describe` block, since none existed before this task):

```js
describe("startReplaceNodeOperation canary option", () => {
  it("passes canary through to the RPC's p_detail", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "op-9" }, error: null });
    await startReplaceNodeOperation(
      { rpc },
      { newNodeId: "n2", role: "EXIT", locationId: "loc-1", provider: "hetzner", region: "fsn1", hostname: "n2.test", oldNodeId: "n1", canary: true }
    );
    expect(rpc).toHaveBeenCalledWith(
      "register_node_replace_operation",
      expect.objectContaining({ p_detail: { provider: "hetzner", region: "fsn1", canary: true } })
    );
  });

  it("defaults canary to false when omitted", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "op-9" }, error: null });
    await startReplaceNodeOperation(
      { rpc },
      { newNodeId: "n2", role: "EXIT", locationId: "loc-1", provider: "hetzner", region: "fsn1", hostname: "n2.test", oldNodeId: "n1" }
    );
    expect(rpc).toHaveBeenCalledWith(
      "register_node_replace_operation",
      expect.objectContaining({ p_detail: { provider: "hetzner", region: "fsn1", canary: false } })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fleet-operations`
Expected: FAIL — `AWAIT_CANARY` is not a step in `REPLACE_NODE_STEPS`, `CANARY_OBSERVATION_MS`/`CANARY_SESSION_CAP` are not exported, `MARK_READY` always writes `READY`.

- [ ] **Step 3: Extend loadNode's select list**

In `functions/lib/fleet-operations.js`, find `loadNode` (near the top of
the file) and extend its `.select(...)` string to include the two columns
`AWAIT_CANARY` needs — this is a shared function used by every handler via
`advanceOperation`'s main loop, so the addition is purely additive and safe
for `CREATE_NODE` handlers too (they simply ignore the extra fields):

```js
async function loadNode(supabase, nodeId) {
  const { data, error } = await supabase
    .from("nodes")
    .select(
      "node_id, role, lifecycle_state, hostname, provider, provider_instance_id, ip_address, dns_record_id, last_seen_at, bootstrap_stage, bootstrap_status, bootstrap_message, consecutive_probe_failures, lifecycle_state_changed_at"
    )
    .eq("node_id", nodeId)
    .maybeSingle();
  if (error) throw new Error(`nodes lookup failed: ${error.message}`);
  if (!data) throw new FatalStepError(`node ${nodeId} no longer exists`);
  return data;
}
```

- [ ] **Step 4: Add the FAILURE_THRESHOLD import**

Near the top of `functions/lib/fleet-operations.js`, add:

```js
import { FAILURE_THRESHOLD } from "./node-health-transition.js";
```

- [ ] **Step 5: Add CANARY constants and the new step to REPLACE_NODE_STEPS**

Change:

```js
export const REPLACE_NODE_STEPS = [...CREATE_NODE_STEPS, "DRAIN_OLD_NODE", "RETIRE_OLD_NODE"];
```

to:

```js
export const CANARY_OBSERVATION_MS = 2 * 60 * 60 * 1000; // 2 hours
export const CANARY_SESSION_CAP = 10;

export const REPLACE_NODE_STEPS = [...CREATE_NODE_STEPS, "AWAIT_CANARY", "DRAIN_OLD_NODE", "RETIRE_OLD_NODE"];
```

- [ ] **Step 6: Override MARK_READY and add AWAIT_CANARY in REPLACE_NODE_HANDLERS**

In `REPLACE_NODE_HANDLERS` (currently `{ ...CREATE_NODE_HANDLERS, async DRAIN_OLD_NODE(...) {...}, async RETIRE_OLD_NODE(...) {...} }`), add a `MARK_READY` override (before `DRAIN_OLD_NODE`, so the object literal reads top-to-bottom in step order) and the new `AWAIT_CANARY` handler:

```js
const REPLACE_NODE_HANDLERS = {
  ...CREATE_NODE_HANDLERS,

  // Overrides CREATE_NODE_HANDLERS.MARK_READY: when this operation is
  // canary-mode, the new node goes to CANARY instead of READY, and
  // AWAIT_CANARY (below) is what eventually promotes it. Non-canary
  // REPLACE_NODE operations (detail.canary is false/absent) behave
  // identically to CREATE_NODE_HANDLERS.MARK_READY.
  async MARK_READY({ supabase }, op, node) {
    if (node.lifecycle_state === "READY" || node.lifecycle_state === "CANARY") return done();
    const targetState = op.detail.canary ? "CANARY" : "READY";
    if (!canTransitionLifecycle(node.lifecycle_state, targetState)) {
      throw new FatalStepError(`cannot mark ${node.lifecycle_state} node ${targetState}`);
    }
    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: targetState, lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: node.lifecycle_state }
    );
    if (!moved) throw new Error("node lifecycle changed concurrently");
    return done();
  },

  async AWAIT_CANARY({ supabase }, op, node) {
    if (!op.detail.canary || node.lifecycle_state === "READY") return done();
    if (node.lifecycle_state !== "CANARY") {
      throw new FatalStepError(`node entered ${node.lifecycle_state} during canary observation`);
    }

    const failures = node.consecutive_probe_failures ?? 0;
    if (failures >= FAILURE_THRESHOLD) {
      const moved = await updateNode(
        supabase,
        node.node_id,
        { lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString() },
        { lifecycle_state: "CANARY" }
      );
      if (!moved) throw new Error("node lifecycle changed concurrently");
      throw new FatalStepError(
        `node ${node.node_id} failed canary observation (${failures} consecutive probe failures)`
      );
    }

    const elapsedMs = Date.now() - new Date(node.lifecycle_state_changed_at).getTime();
    if (elapsedMs < CANARY_OBSERVATION_MS) {
      return wait(DRAIN_POLL_INTERVAL_S, {});
    }

    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: "READY", lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: "CANARY" }
    );
    if (!moved) throw new Error("node lifecycle changed concurrently");
    return done();
  },

  async DRAIN_OLD_NODE({ supabase }, op, _newNode, step) {
    // ... unchanged, existing Phase 12a code ...
```

(Leave `DRAIN_OLD_NODE` and `RETIRE_OLD_NODE` exactly as they are — only
`MARK_READY` and the new `AWAIT_CANARY` are added/changed in this step.)

- [ ] **Step 7: Add CANARY to failNodeIfBooting's recovery list**

In `functions/lib/fleet-operations.js`, find `failNodeIfBooting`:

```js
async function failNodeIfBooting(supabase, nodeId) {
  if (!nodeId) return;
  for (const from of ["PROVISIONING", "WARMING_UP"]) {
```

Change the `for` loop's array to also include `"CANARY"`, so a node stuck
in canary observation when its operation hits the (very generous, 72h+)
outer deadline is still recoverable, not left permanently stranded:

```js
  for (const from of ["PROVISIONING", "WARMING_UP", "CANARY"]) {
```

- [ ] **Step 8: Thread `canary` through startReplaceNodeOperation**

Change the function signature and RPC call:

```js
export async function startReplaceNodeOperation(
  supabase,
  {
    newNodeId,
    role,
    locationId,
    provider,
    region,
    hostname,
    oldNodeId,
    maxWaitHours = DEFAULT_REPLACE_MAX_WAIT_HOURS,
    canary = false,
  }
) {
  const deadlineMs = CREATE_NODE_DEADLINE_MS + maxWaitHours * 60 * 60 * 1000 + REPLACE_DEADLINE_BUFFER_MS;
  const { data: operation, error } = await supabase.rpc("register_node_replace_operation", {
    p_node_id: newNodeId,
    p_role: role,
    p_location_id: locationId,
    p_provider: provider,
    p_hostname: hostname,
    p_detail: { provider, region, canary },
    p_old_node_id: oldNodeId,
    p_max_wait_hours: maxWaitHours,
    p_steps: REPLACE_NODE_STEPS,
    p_deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
  });
  if (error) return { error };
  return { operation };
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test -- fleet-operations`
Expected: PASS. If `replaceSeed()`'s `oldState_READY_default()` helper
feels awkward, inline `"READY"` directly in that one assertion instead —
it exists only because `replaceSeed`'s default `oldState` value needs
naming somewhere; either form is fine.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all tests pass (this task's changes to `loadNode` and
`failNodeIfBooting` are shared with `CREATE_NODE` — confirm no existing
`CREATE_NODE` test broke).

- [ ] **Step 11: Commit**

```bash
git add functions/lib/fleet-operations.js functions/lib/__tests__/fleet-operations.test.js
git commit -m "feat(fleet): AWAIT_CANARY saga step for canary-mode replacement"
```

---

### Task 3: Scheduler inclusion of CANARY nodes

**Files:**
- Modify: `functions/lib/scheduler.js`
- Test: `functions/lib/__tests__/scheduler.test.js`

**Interfaces:**
- Consumes: `CANARY_SESSION_CAP` (Task 2, `./fleet-operations.js`).
- Produces: nothing new consumed by later tasks — this task only changes scheduling candidate eligibility.

- [ ] **Step 1: Write the failing tests**

The existing test file has two hand-rolled Supabase mocks, neither of
which implements `.in()` (they only implement `.eq()`/`.select()`) — the
production code change in Step 3 below switches from `.eq("lifecycle_state",
"READY")` to `.in("lifecycle_state", [...])`, which would otherwise throw
`TypeError: ...in is not a function` against these existing mocks. Update
both mocks first, then add new tests.

In `functions/lib/__tests__/scheduler.test.js`, in
`scheduleNodeForDevice (DB-facing)`'s `makeSupabaseWithNodes`, change the
`nodesQuery.eq` mock:

```js
    const nodesQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn(function (column, values) {
        if (column === "lifecycle_state") {
          filteredNodes = nodes.filter(
            (node) => !node.lifecycle_state || values.includes(node.lifecycle_state)
          );
        }
        return this;
      }),
    };
```

(This replaces the old `eq`-based special-case entirely — the production
code no longer calls `.eq("lifecycle_state", ...)` at all, only `.in(...)`,
so the mock's filtering logic moves there. `eq` becomes a plain
`mockReturnThis()` passthrough, same as it already is for other columns in
this same mock.)

In `scheduleDoubleHopForDevice (DB-facing)`'s `makeSupabase`, the `nodes`
branch's `query` object gets a no-op `.in()` added (this mock never
simulated lifecycle_state filtering — it relies on test fixtures already
being pre-filtered — so `.in()` only needs to not crash):

```js
      if (table === "nodes") {
        let role = null;
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(function (column, value) {
            if (column === "role") role = value;
            return this;
          }),
          in: vi.fn().mockReturnThis(),
        };
        query.then = (resolve) =>
          resolve({ data: role === "RELAY" ? relayNodes : exitNodes, error: null });
        return query;
      }
```

Now add the new tests. First, extend the import at the top of the file to
include `scheduleAutoForDevice` (add it to the existing import list if not
already present) and `CANARY_SESSION_CAP` from `../fleet-operations.js`:

```js
import { CANARY_SESSION_CAP } from "../fleet-operations.js";
```

Add to `scheduleNodeForDevice (DB-facing)`:

```js
it("includes a CANARY node as a candidate, capped at CANARY_SESSION_CAP regardless of its own max_sessions", async () => {
  const { from, upsert } = makeSupabaseWithNodes({
    allowedPath: { id: "path-1" },
    sticky: null,
    nodes: [
      { node_id: "canary-node", configured_users: CANARY_SESSION_CAP, max_sessions: 1000, lifecycle_state: "CANARY" },
      { node_id: "ready-node", configured_users: 50, max_sessions: 1000, lifecycle_state: "READY" },
    ],
  });
  const result = await scheduleNodeForDevice({ from }, { deviceId: "device-1", exitLocationId: "loc-1" });
  // canary-node is at its cap (configured_users === CANARY_SESSION_CAP),
  // so it must not be picked even though it would otherwise look
  // least-loaded against a node with max_sessions: 1000.
  expect(result).toBe("ready-node");
  expect(upsert).toHaveBeenCalledWith(
    { device_id: "device-1", node_id: "ready-node", hop: "EXIT" },
    { onConflict: "device_id,hop" }
  );
});

it("picks an under-cap CANARY node over a more-loaded READY node", async () => {
  const { from, upsert } = makeSupabaseWithNodes({
    allowedPath: { id: "path-1" },
    sticky: null,
    nodes: [
      { node_id: "canary-node", configured_users: 2, max_sessions: 1000, lifecycle_state: "CANARY" },
      { node_id: "ready-node", configured_users: 50, max_sessions: 1000, lifecycle_state: "READY" },
    ],
  });
  const result = await scheduleNodeForDevice({ from }, { deviceId: "device-1", exitLocationId: "loc-1" });
  expect(result).toBe("canary-node");
  expect(upsert).toHaveBeenCalledWith(
    { device_id: "device-1", node_id: "canary-node", hop: "EXIT" },
    { onConflict: "device_id,hop" }
  );
});
```

Add to `scheduleDoubleHopForDevice (DB-facing)` (after the existing tests):

```js
it("includes CANARY nodes for both hops, capped independently", async () => {
  const { from, upsert } = makeSupabase({
    allowedPath: { id: "path-1" },
    relaySticky: null,
    exitSticky: null,
    relayNodes: [{ node_id: "relay-canary", configured_users: 1, max_sessions: 1000, lifecycle_state: "CANARY" }],
    exitNodes: [{ node_id: "exit-canary", configured_users: 1, max_sessions: 1000, lifecycle_state: "CANARY" }],
  });
  const result = await scheduleDoubleHopForDevice(
    { from },
    { deviceId: "device-1", entryLocationId: "loc-ru", exitLocationId: "loc-de" }
  );
  expect(result).toEqual({ relayNodeId: "relay-canary", exitNodeId: "exit-canary" });
  expect(upsert).toHaveBeenCalled();
});
```

Add a new `describe` block for `scheduleAutoForDevice` (this function has
no existing test coverage in this file — this is the first):

```js
describe("scheduleAutoForDevice (DB-facing)", () => {
  function makeSupabaseAuto({ paths, sticky, nodes }) {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table) => {
      if (table === "allowed_paths") {
        return {
          select: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: paths, error: null }),
        };
      }
      if (table === "device_node_assignments") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: sticky, error: null }),
          upsert,
        };
      }
      if (table === "nodes") {
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
        };
        query.then = (resolve) => resolve({ data: nodes, error: null });
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { from, upsert };
  }

  it("includes a CANARY node as a candidate, capped like the direct scheduler", async () => {
    const { from } = makeSupabaseAuto({
      paths: [{ exit_location_id: "loc-1" }],
      sticky: null,
      nodes: [
        { node_id: "canary-node", configured_users: CANARY_SESSION_CAP, max_sessions: 1000, lifecycle_state: "CANARY" },
        { node_id: "ready-node", configured_users: 50, max_sessions: 1000, lifecycle_state: "READY" },
      ],
    });
    const result = await scheduleAutoForDevice({ from }, { deviceId: "device-1" });
    expect(result).toBe("ready-node");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scheduler`
Expected: FAIL — the query still filters `lifecycle_state = 'READY'` only,
so `canary-node` never appears as a candidate, and `scheduleAutoForDevice`
isn't imported yet.

- [ ] **Step 3: Update the three scheduling functions**

In `functions/lib/scheduler.js`, add the import at the top:

```js
import { CANARY_SESSION_CAP } from "./fleet-operations.js";
```

In `isUnderCapacity`, add a canary-aware cap:

```js
function isUnderCapacity(node) {
  const effectiveMax =
    node.lifecycleState === "CANARY"
      ? Math.min(node.maxSessions ?? Infinity, CANARY_SESSION_CAP)
      : node.maxSessions;
  if (effectiveMax == null) return true;
  return (node.configuredUsers ?? 0) < effectiveMax;
}
```

(`node.lifecycleState` is a new field on the candidate objects this
function receives — added below.)

In `scheduleNodeForDevice`, change the nodes query:

```js
  const { data: nodes, error: nodesError } = await supabaseAdmin
    .from("nodes")
    .select("node_id, configured_users, max_sessions, lifecycle_state")
    .eq("role", "EXIT")
    .in("lifecycle_state", ["READY", "CANARY"])
    .eq("location_id", exitLocationId);
```

and the candidate-mapping `.map(...)` to carry `lifecycleState` through:

```js
  const candidates = (nodes ?? [])
    .map((node) => ({
      nodeId: node.node_id,
      configuredUsers: node.configured_users,
      maxSessions: node.max_sessions,
      lifecycleState: node.lifecycle_state,
    }))
    .filter(isUnderCapacity);
```

In `scheduleDoubleHopForDevice`, change both nodes queries the same way.
The relay query:

```js
    supabaseAdmin
      .from("nodes")
      .select("node_id, configured_users, max_sessions, lifecycle_state")
      .eq("role", "RELAY")
      .in("lifecycle_state", ["READY", "CANARY"])
      .eq("location_id", entryLocationId),
```

The exit query:

```js
    supabaseAdmin
      .from("nodes")
      .select("node_id, configured_users, max_sessions, lifecycle_state")
      .eq("role", "EXIT")
      .in("lifecycle_state", ["READY", "CANARY"])
      .eq("location_id", exitLocationId),
```

And the shared `toCandidates` helper inside this function:

```js
  const toCandidates = (nodes) =>
    (nodes ?? [])
      .map((node) => ({
        nodeId: node.node_id,
        configuredUsers: node.configured_users,
        maxSessions: node.max_sessions,
        lifecycleState: node.lifecycle_state,
      }))
      .filter(isUnderCapacity);
```

In `scheduleAutoForDevice`, change the nodes query:

```js
  const { data: nodes, error: nodesError } = await supabaseAdmin
    .from("nodes")
    .select("node_id, configured_users, max_sessions, lifecycle_state")
    .eq("role", "EXIT")
    .in("lifecycle_state", ["READY", "CANARY"])
    .in("location_id", locationIds);
```

and its candidate mapping:

```js
  const candidates = (nodes ?? [])
    .map((node) => ({
      nodeId: node.node_id,
      configuredUsers: node.configured_users,
      maxSessions: node.max_sessions,
      lifecycleState: node.lifecycle_state,
    }))
    .filter(isUnderCapacity);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scheduler`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/scheduler.js functions/lib/__tests__/scheduler.test.js
git commit -m "feat(fleet): scheduler includes capped CANARY nodes as placement candidates"
```

---

### Task 4: Admin route opt-in

**Files:**
- Modify: `functions/api/admin/nodes/[id]/replace.js`
- Test: `functions/api/admin/nodes/[id]/__tests__/replace.test.js`

**Interfaces:**
- Consumes: `startReplaceNodeOperation`'s new `canary` option (Task 2).
- Produces: `POST /api/admin/nodes/:id/replace` accepts an optional `canary: boolean` body field, default `false`.

- [ ] **Step 1: Write the failing test**

Add to `functions/api/admin/nodes/[id]/__tests__/replace.test.js`:

```js
it("passes canary: true through to startReplaceNodeOperation when requested", async () => {
  const res = await onRequestPost({
    env,
    request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1", canary: true }),
    params: { id: "de-fsn-001" },
  });
  expect(res.status).toBe(202);
  expect(startReplaceNodeOperation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ canary: true })
  );
});

it("defaults canary to false when omitted", async () => {
  await onRequestPost({
    env,
    request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
    params: { id: "de-fsn-001" },
  });
  expect(startReplaceNodeOperation).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ canary: false })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- replace`
Expected: FAIL — `startReplaceNodeOperation` is called without a `canary` field at all.

- [ ] **Step 3: Add the field to the route**

In `functions/api/admin/nodes/[id]/replace.js`, after the existing
`maxWaitHours` parsing block, add:

```js
  const canary = body?.canary === true;
```

Then add `canary` to the `startReplaceNodeOperation` call's options object:

```js
    const { operation, error } = await startReplaceNodeOperation(supabaseAdmin, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider,
      region,
      hostname,
      oldNodeId,
      maxWaitHours,
      canary,
    });
```

Also add `canary` to the audit-log `metadata` object, alongside the
existing fields:

```js
    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.node_replace_initiated",
      targetType: "node",
      targetId: oldNodeId,
      metadata: { oldNodeId, newNodeId, operationId: operation.id, provider, region, maxWaitHours, canary },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- replace`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add "functions/api/admin/nodes/[id]/replace.js" "functions/api/admin/nodes/[id]/__tests__/replace.test.js"
git commit -m "feat(fleet): admin replace route accepts optional canary flag"
```

---

### Task 5: Auto-trigger canary flag

**Files:**
- Modify: `functions/lib/node-auto-replace.js`
- Test: `functions/lib/__tests__/node-auto-replace.test.js`

**Interfaces:**
- Consumes: `startReplaceNodeOperation`'s new `canary` option (Task 2).
- Produces: `autoReplaceFailedNodes` passes `canary: true` when both `env.FEATURE_AUTO_NODE_REPLACE === "true"` (checked by the caller, `fleet-tick.js`, unchanged) and `env.FEATURE_AUTO_NODE_REPLACE_CANARY === "true"` (new, checked inside this function).

- [ ] **Step 1: Write the failing tests**

Add to `functions/lib/__tests__/node-auto-replace.test.js`:

```js
it("passes canary: true when FEATURE_AUTO_NODE_REPLACE_CANARY is enabled", async () => {
  const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
  await autoReplaceFailedNodes(db, { ...baseEnv, FEATURE_AUTO_NODE_REPLACE_CANARY: "true" });
  expect(startReplaceNodeOperation).toHaveBeenCalledWith(
    db,
    expect.objectContaining({ canary: true })
  );
});

it("defaults canary to false when FEATURE_AUTO_NODE_REPLACE_CANARY is unset", async () => {
  const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
  await autoReplaceFailedNodes(db, baseEnv);
  expect(startReplaceNodeOperation).toHaveBeenCalledWith(
    db,
    expect.objectContaining({ canary: false })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- node-auto-replace`
Expected: FAIL — `startReplaceNodeOperation` is called without a `canary` field.

- [ ] **Step 3: Add the flag check**

In `functions/lib/node-auto-replace.js`, inside `autoReplaceFailedNodes`,
near the top (after the `region` check, before the candidate query — order
doesn't matter functionally, but keeping config checks together matches
the existing style):

```js
  const canary = env.FEATURE_AUTO_NODE_REPLACE_CANARY === "true";
```

Then add `canary` to the `startReplaceNodeOperation` call inside the loop:

```js
    const { operation, error: startError } = await startReplaceNodeOperation(supabase, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider: oldNode.provider,
      region,
      hostname,
      oldNodeId: oldNode.node_id,
      canary,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- node-auto-replace`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/node-auto-replace.js functions/lib/__tests__/node-auto-replace.test.js
git commit -m "feat(fleet): auto-replace canary mode behind FEATURE_AUTO_NODE_REPLACE_CANARY"
```

---

### Task 6: Staging verification (manual — requires live infrastructure access)

**Files:** none (operational verification, not code).

This task cannot be executed by an automated implementer or subagent — it
requires an account with real provider/DNS credentials against the staging
environment, per the fleet plan's standing requirement that data-plane
claims be verified against real infrastructure (spec §5-equivalent
reasoning, mirroring Phase 8's and Phase 12a's own staging-verification
tasks).

- [ ] **Step 1:** In staging, trigger `POST /api/admin/nodes/<real-node-id>/replace` with `canary: true` against a real `READY` node with at least one real device assignment.
- [ ] **Step 2:** Confirm via the admin Jobs view that the new node reaches `CANARY` (not `READY`) once provisioning completes, and that the old node is still untouched (still `READY`, still serving).
- [ ] **Step 3:** Confirm the canary node actually receives some real traffic (check its `configured_users`/traffic sample rows climb, capped near `CANARY_SESSION_CAP`) while genuinely healthy devices continue landing on the old node too.
- [ ] **Step 4:** Confirm that after the observation window elapses, the canary node promotes to `READY`, and the existing drain/retire flow (Phase 12a, unchanged) proceeds normally from there.
- [ ] **Step 5:** Separately, force the canary node's sing-box process to fail mid-window (same technique as Phase 8's staging check) and confirm the operation aborts: canary node reaches `FAILED`, the old node is never touched, and no drain/retire ever starts.
- [ ] **Step 6:** Report results back; if any step fails, file it as a bug against this plan's tasks rather than editing staging state by hand.
