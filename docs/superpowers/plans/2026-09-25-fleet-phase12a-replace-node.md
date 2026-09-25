# Fleet Phase 12a: Replace-Node Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin (or, once enabled, automation) replace a fleet node with a freshly provisioned one, safely draining devices off the old node before retiring it, entirely via the existing `fleet_operations` saga engine.

**Architecture:** A new `REPLACE_NODE` operation type reuses all six `CREATE_NODE_HANDLERS` unmodified for provisioning the new node, then adds two new steps (`DRAIN_OLD_NODE`, `RETIRE_OLD_NODE`) that transition the old node through `DRAINING` → `RETIRED` and tear down its provider instance. A new admin route triggers it manually; `fleet-tick`'s reconciler optionally triggers it automatically for sustained-`FAILED` nodes.

**Tech Stack:** Cloudflare Pages Functions (JS), Supabase/Postgres migrations, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-25-fleet-phase12a-replace-node-design.md`

## Global Constraints

- Old node may only start a replacement from `READY`, `DEGRADED`, or `FAILED` (spec §4.3). `QUARANTINED` is never replace-eligible — it is a one-way security containment.
- The old node is never touched (no `DRAINING` transition) until the new node reaches `MARK_READY` (spec §4.3's ordering safety net).
- `idempotency_key = "REPLACE_NODE:" || oldNodeId` — exactly one in-flight-or-ever `REPLACE_NODE` operation per old node id (spec §4.3).
- Default `maxWaitHours = 72` unless the caller overrides it (spec §4.4).
- `DRAIN_OLD_NODE` forces through past `drainDeadline` even with devices still assigned — retirement must never wait forever (spec §4.1).
- Every write to `nodes.lifecycle_state`, anywhere in the codebase, must also set `lifecycle_state_changed_at = now()` in the same update (spec §4.5) — this task touches every existing call site, not just the new ones.
- `FEATURE_AUTO_NODE_REPLACE` gates only the auto-trigger path in `fleet-tick.js`; the admin-initiated route ships unconditionally (spec §4.7).
- Auto-trigger requires a configured default provisioning region (`FLEET_AUTO_REPLACE_REGION`) since, unlike the admin route, there is no human typing one in per replacement — this env var is a plan-level addition not named in the spec (the spec did not resolve how an automated trigger sources a region; region is not stored per-node anywhere in the schema, confirmed against `supabase/migrations/20260924000000_fleet_foundations.sql`). Auto-replace no-ops (logs and skips) with this unset.

## Review Focus

- **A device still on the old node when its app never reopens** (e.g. uninstalled, permanently offline): must not block retirement forever — pinned by Task 4's drain-timeout-forces-through test.
- **New-node provisioning fails partway through** (any of the six reused `CREATE_NODE` steps): the old node must be completely untouched — still serving, still in its original `lifecycle_state` — pinned by Task 4's provisioning-failure-leaves-old-node-untouched test.
- **An admin manually quarantines the old node mid-replacement** (between `DRAIN_OLD_NODE`'s first and a later tick): the compare-and-set must fail closed rather than silently overwrite the admin's QUARANTINE — pinned by Task 4's concurrent-state-change test.
- **A second replace request for a node already mid-replacement**: must be rejected, not silently start a duplicate operation or duplicate provider instance — pinned by Task 5's duplicate-idempotency-key test.
- **`FEATURE_AUTO_NODE_REPLACE` enabled with no `FLEET_AUTO_REPLACE_REGION` configured**: must no-op and log, never crash the reconciler tick (which also advances unrelated operations and finalizes account deletions in the same request) — pinned by Task 6's missing-region-config test.

---

### Task 1: Migration — lifecycle_state_changed_at, FAILED→DRAINING edge, register_node_replace_operation RPC

**Files:**
- Create: `supabase/migrations/20260926000000_replace_node_operation.sql`
- Modify: `functions/lib/node-lifecycle.js:52` (FAILED's allowed transitions)
- Test: `functions/lib/__tests__/node-lifecycle.test.js`

**Interfaces:**
- Produces: `nodes.lifecycle_state_changed_at` column (timestamptz, not null, default `now()`); `register_node_replace_operation(p_node_id, p_role, p_location_id, p_provider, p_hostname, p_detail, p_old_node_id, p_max_wait_hours, p_steps, p_deadline_at) returns fleet_operations` RPC; `canTransitionLifecycle("FAILED", "DRAINING")` now returns `true`.

- [ ] **Step 1: Write the failing test for the new lifecycle edge**

Add to `functions/lib/__tests__/node-lifecycle.test.js`:

```js
it("allows FAILED to DRAINING (Phase 12a replace-node drain path)", () => {
  expect(canTransitionLifecycle("FAILED", "DRAINING")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-lifecycle`
Expected: FAIL — `expect(received).toBe(true)` received `false`.

- [ ] **Step 3: Add the edge in node-lifecycle.js**

In `functions/lib/node-lifecycle.js`, change the `FAILED` entry (currently
`FAILED: ["PROVISIONING", "READY", "QUARANTINED", "RETIRED"],`) to:

```js
  // DRAINING here is the Phase 12a replace-node edge: a FAILED node being
  // replaced (functions/lib/fleet-operations.js's DRAIN_OLD_NODE step) must
  // reach DRAINING the same way a READY or DEGRADED node being replaced
  // does -- a FAILED node's own passive-drain path (its devices reconnecting
  // via the scheduler's READY-only filter) does not depend on whether the
  // old node is reachable at all.
  FAILED: ["PROVISIONING", "READY", "DRAINING", "QUARANTINED", "RETIRED"],
```

Also update the file's header comment (lines 13-18) to mention this edge
alongside the Phase 8 ones it already documents:

```js
 * Phase 8 added the health-based edges READY<->DEGRADED, READY->FAILED,
 * DEGRADED->FAILED and FAILED->READY. Phase 12a added FAILED->DRAINING (a
 * FAILED node can be replaced, same as a READY or DEGRADED one). Automation
 * does NOT get everything this table allows: functions/lib/node-health-transition.js
 * and functions/lib/fleet-operations.js's REPLACE_NODE handlers each spell
 * out their own narrower set of automated moves, using canTransitionLifecycle
 * only as a secondary guard.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-lifecycle`
Expected: PASS.

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/20260926000000_replace_node_operation.sql`:

```sql
-- Fleet Phase 12a: replace-node workflow.
--
-- 1. lifecycle_state_changed_at lets the auto-replace check (fleet-tick.js,
--    Task 6) ask "how long has this node been FAILED", something nothing
--    in the schema could answer before -- lifecycle_state itself carries no
--    timestamp of its own transition. Every existing write path that sets
--    lifecycle_state is updated in the same phase (Task 2) to also set this
--    column, so it is never stale for any node regardless of which code
--    path moved it.
-- 2. register_node_replace_operation() mirrors register_node_create_operation()
--    (20260925000000_node_bootstrap.sql): registers a PROVISIONING new node
--    together with its REPLACE_NODE operation and steps in one transaction.
--    Detail carries oldNodeId/maxWaitHours merged into the caller's
--    provider/region detail, matching CREATE_NODE's detail shape so the six
--    reused CREATE_NODE_HANDLERS need no special-casing to read
--    detail.provider/detail.region.

alter table public.nodes
  add column lifecycle_state_changed_at timestamptz;

update public.nodes set lifecycle_state_changed_at = now();

alter table public.nodes
  alter column lifecycle_state_changed_at set not null,
  alter column lifecycle_state_changed_at set default now();

create or replace function public.register_node_replace_operation(
  p_node_id text,
  p_role text,
  p_location_id uuid,
  p_provider text,
  p_hostname text,
  p_detail jsonb,
  p_old_node_id text,
  p_max_wait_hours integer,
  p_steps text[],
  p_deadline_at timestamptz
)
returns public.fleet_operations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op public.fleet_operations;
begin
  insert into public.nodes (node_id, role, location_id, lifecycle_state, provider, hostname, lifecycle_state_changed_at)
  values (p_node_id, p_role, p_location_id, 'PROVISIONING', p_provider, p_hostname, now());

  insert into public.fleet_operations (type, node_id, idempotency_key, detail, deadline_at)
  values (
    'REPLACE_NODE',
    p_node_id,
    'REPLACE_NODE:' || p_old_node_id,
    p_detail || jsonb_build_object('oldNodeId', p_old_node_id, 'maxWaitHours', p_max_wait_hours),
    p_deadline_at
  )
  returning * into v_op;

  insert into public.operation_steps (operation_id, step_index, name, node_id)
  select v_op.id, s.ord - 1, s.name, p_node_id
  from unnest(p_steps) with ordinality as s(name, ord);

  return v_op;
end;
$$;

revoke all on function public.register_node_replace_operation(text, text, uuid, text, text, jsonb, text, integer, text[], timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_node_replace_operation(text, text, uuid, text, text, jsonb, text, integer, text[], timestamptz)
  to service_role;
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260926000000_replace_node_operation.sql functions/lib/node-lifecycle.js functions/lib/__tests__/node-lifecycle.test.js
git commit -m "feat(fleet): Phase 12a migration — lifecycle_state_changed_at, FAILED->DRAINING, replace-node RPC"
```

---

### Task 2: Set lifecycle_state_changed_at on every existing lifecycle_state write

**Files:**
- Modify: `functions/lib/node-silence-failover.js:29`
- Modify: `functions/api/agent/heartbeat.js:121`
- Modify: `functions/api/admin/nodes/[id]/lifecycle.js:54`
- Modify: `functions/lib/fleet-operations.js` (`MARK_READY` handler and `failNodeIfBooting`)
- Test: `functions/lib/__tests__/node-silence-failover.test.js`, `functions/api/agent/__tests__/heartbeat.test.js`, `functions/api/admin/nodes/[id]/__tests__/lifecycle.test.js`, `functions/lib/__tests__/fleet-operations.test.js`

**Interfaces:**
- Consumes: `nodes.lifecycle_state_changed_at` (Task 1).
- Produces: nothing new consumed by later tasks — this task's guarantee (every write sets the column) is what Task 6's auto-replace query depends on being true.

This is one mechanical, same-shape change repeated across five call sites: wherever an object literal sets `lifecycle_state`, add a sibling `lifecycle_state_changed_at: new Date().toISOString()`. Batch as one dispatch.

- [ ] **Step 1: Write the failing tests, one per call site**

`functions/lib/__tests__/node-silence-failover.test.js` — add near the existing "transitions a silent node to FAILED" test:

```js
it("sets lifecycle_state_changed_at when transitioning a silent node to FAILED", async () => {
  const db = makeFakeSupabase({
    nodes: [{ node_id: "n1", lifecycle_state: "READY", last_seen_at: new Date(Date.now() - 10 * HEARTBEAT_INTERVAL_MS).toISOString() }],
    operational_alerts: [],
  });
  const before = Date.now();
  await failSilentNodes(db, db._tables.nodes, Date.now());
  const changedAt = new Date(db._tables.nodes[0].lifecycle_state_changed_at).getTime();
  expect(changedAt).toBeGreaterThanOrEqual(before);
});
```

(Import `HEARTBEAT_INTERVAL_MS` from `../node-health-transition.js` and `makeFakeSupabase` from `./fake-supabase.js` at the top of the file if not already imported — check the file's existing imports first, since the test file already exercises `failSilentNodes` and likely has both.)

`functions/api/agent/__tests__/heartbeat.test.js` — find the existing test that asserts a probe-streak transition writes `lifecycle_state` (search for `.update({ lifecycle_state:` in the test file's assertions) and extend its assertion to also check the timestamp field is present and recent:

```js
expect(new Date(updatedNode.lifecycle_state_changed_at).getTime()).toBeGreaterThan(Date.now() - 5000);
```

`functions/api/admin/nodes/[id]/__tests__/lifecycle.test.js` — extend the existing successful-transition test's assertion the same way, checking the row passed to `.update()` (or the resulting row in the fake DB) includes `lifecycle_state_changed_at`.

`functions/lib/__tests__/fleet-operations.test.js` — add two tests:

```js
it("sets lifecycle_state_changed_at when MARK_READY transitions the node to READY", async () => {
  await setNode({ lifecycle_state: "WARMING_UP", bootstrap_stage: "COMPLETE", bootstrap_status: "OK", last_seen_at: new Date().toISOString() });
  for (let i = 0; i < READINESS_CONSECUTIVE_PASSES; i++) await advance();
  const changedAt = new Date((await node()).lifecycle_state_changed_at).getTime();
  expect(changedAt).toBeGreaterThan(Date.now() - 5000);
});

it("sets lifecycle_state_changed_at when a deadline-exceeded operation fails a booting node", async () => {
  db = makeFakeSupabase(seed({ deadlineAt: new Date(Date.now() - 1000).toISOString() }));
  ctx.supabase = db;
  await advance();
  const changedAt = new Date((await node()).lifecycle_state_changed_at).getTime();
  expect(changedAt).toBeGreaterThan(Date.now() - 5000);
});
```

- [ ] **Step 2: Run all four suites to verify they fail**

Run: `npm test -- node-silence-failover heartbeat lifecycle fleet-operations`
Expected: FAIL — each new assertion finds `lifecycle_state_changed_at` `undefined`.

- [ ] **Step 3: Add the field at each of the five call sites**

`functions/lib/node-silence-failover.js:29`, change:

```js
      .update({ lifecycle_state: "FAILED" })
```
to:
```js
      .update({ lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString() })
```

`functions/api/agent/heartbeat.js:121`, change:

```js
      .update({ lifecycle_state: nextState })
```
to:
```js
      .update({ lifecycle_state: nextState, lifecycle_state_changed_at: new Date().toISOString() })
```

`functions/api/admin/nodes/[id]/lifecycle.js:54`, change:

```js
    const update = { lifecycle_state: body.state };
```
to:
```js
    const update = { lifecycle_state: body.state, lifecycle_state_changed_at: new Date().toISOString() };
```

`functions/lib/fleet-operations.js`, `MARK_READY` handler, change:

```js
    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: "READY" },
      { lifecycle_state: node.lifecycle_state }
    );
```
to:
```js
    const moved = await updateNode(
      supabase,
      node.node_id,
      { lifecycle_state: "READY", lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: node.lifecycle_state }
    );
```

`functions/lib/fleet-operations.js`, `failNodeIfBooting`, change:

```js
async function failNodeIfBooting(supabase, nodeId) {
  if (!nodeId) return;
  for (const from of ["PROVISIONING", "WARMING_UP"]) {
    await updateNode(supabase, nodeId, { lifecycle_state: "FAILED" }, { lifecycle_state: from });
  }
}
```
to:
```js
async function failNodeIfBooting(supabase, nodeId) {
  if (!nodeId) return;
  for (const from of ["PROVISIONING", "WARMING_UP"]) {
    await updateNode(
      supabase,
      nodeId,
      { lifecycle_state: "FAILED", lifecycle_state_changed_at: new Date().toISOString() },
      { lifecycle_state: from }
    );
  }
}
```

- [ ] **Step 4: Run all four suites to verify they pass**

Run: `npm test -- node-silence-failover heartbeat lifecycle fleet-operations`
Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests still pass — this task only adds a field to update payloads, never changes control flow.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/node-silence-failover.js functions/api/agent/heartbeat.js functions/api/admin/nodes/[id]/lifecycle.js functions/lib/fleet-operations.js functions/lib/__tests__/node-silence-failover.test.js functions/api/agent/__tests__/heartbeat.test.js functions/api/admin/nodes/[id]/__tests__/lifecycle.test.js functions/lib/__tests__/fleet-operations.test.js
git commit -m "feat(fleet): set lifecycle_state_changed_at on every lifecycle_state write"
```

---

### Task 3: REPLACE_NODE steps and handlers in fleet-operations.js

**Files:**
- Modify: `functions/lib/fleet-operations.js`
- Test: `functions/lib/__tests__/fleet-operations.test.js`

**Interfaces:**
- Consumes: `CREATE_NODE_HANDLERS`, `CREATE_NODE_STEPS`, `CREATE_NODE_DEADLINE_MS`, `updateNode`, `canTransitionLifecycle` (all already in this file); `nodes.lifecycle_state_changed_at` (Task 1).
- Produces: `REPLACE_NODE_STEPS` (array), `DEFAULT_REPLACE_MAX_WAIT_HOURS` (number, `72`), `DRAIN_POLL_INTERVAL_S` (number), `startReplaceNodeOperation(supabase, { newNodeId, role, locationId, provider, region, hostname, oldNodeId, maxWaitHours? }) -> Promise<{ operation } | { error }>`. `advanceOperation()` now handles `op.type === "REPLACE_NODE"`.

- [ ] **Step 1: Write the failing tests**

Add to `functions/lib/__tests__/fleet-operations.test.js`, a new `describe` block. First, extend the file's `seed()`-adjacent helpers with a replace-specific seed (add this near the top, after the existing `seed()` function):

```js
const OLD_NODE_ID = "de-fsn-old";

function replaceSeed({ oldState = "READY", drainDeadline } = {}) {
  const base = seed();
  base.nodes.push({
    node_id: OLD_NODE_ID,
    role: "EXIT",
    lifecycle_state: oldState,
    provider: "hetzner",
    provider_instance_id: "old-instance-1",
    ip_address: "198.51.100.1",
  });
  base.fleet_operations[0].type = "REPLACE_NODE";
  base.fleet_operations[0].detail = { provider: "hetzner", region: "fsn1", oldNodeId: OLD_NODE_ID, maxWaitHours: 72 };
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

async function driveNewNodeToReady() {
  await advance(); // CREATE_INSTANCE + PUBLISH_DNS -> AWAIT_ENROLLMENT
  await setNode({ lifecycle_state: "WARMING_UP" });
  await advance(); // -> AWAIT_BOOTSTRAP
  await setNode({ bootstrap_stage: "COMPLETE", bootstrap_status: "OK", last_seen_at: new Date().toISOString() });
  for (let i = 0; i < READINESS_CONSECUTIVE_PASSES; i++) await advance();
}
```

Update the top-level import to also pull in `REPLACE_NODE_STEPS`:

```js
import {
  advanceOperation,
  CREATE_NODE_STEPS,
  REPLACE_NODE_STEPS,
  READINESS_CONSECUTIVE_PASSES,
} from "../fleet-operations.js";
```

Now the tests:

```js
describe("REPLACE_NODE operation", () => {
  it("drives the new node to READY, then drains and retires the old node once assignments clear", async () => {
    db = makeFakeSupabase(replaceSeed());
    ctx.supabase = db;

    await driveNewNodeToReady();
    expect((await node()).lifecycle_state).toBe("READY");

    // DRAIN_OLD_NODE: old node moves to DRAINING on first entry.
    let result = await advance();
    expect(result).toMatchObject({ step: "DRAIN_OLD_NODE", status: "RUNNING" });
    const oldAfterFirstDrainTick = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
    expect(oldAfterFirstDrainTick.lifecycle_state).toBe("DRAINING");

    // Still has an assignment -> keeps waiting.
    await db.from("device_node_assignments").insert({ device_id: "dev-1", node_id: OLD_NODE_ID, hop: "EXIT" });
    result = await advance();
    expect(result).toMatchObject({ step: "DRAIN_OLD_NODE", status: "RUNNING" });

    // Assignment clears -> DRAIN_OLD_NODE completes, RETIRE_OLD_NODE runs.
    await db.from("device_node_assignments").delete().eq("device_id", "dev-1");
    result = await advance();
    expect(result).toEqual({ status: "COMPLETED" });

    const oldFinal = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
    expect(oldFinal.lifecycle_state).toBe("RETIRED");
    expect(oldFinal.retired_at).toBeTruthy();
    expect(provider.destroyInstance).toHaveBeenCalledWith({ providerInstanceId: "old-instance-1" });
  });

  it("forces the drain through once drainDeadline passes, even with assignments remaining", async () => {
    db = makeFakeSupabase(replaceSeed());
    ctx.supabase = db;
    await driveNewNodeToReady();
    await advance(); // starts DRAINING, records drainDeadline
    await db.from("device_node_assignments").insert({ device_id: "dev-1", node_id: OLD_NODE_ID, hop: "EXIT" });

    const drainStep = await step("DRAIN_OLD_NODE");
    // Force the recorded deadline into the past instead of waiting real time.
    await db.from("operation_steps").update({ detail: { ...drainStep.detail, drainDeadline: new Date(Date.now() - 1000).toISOString() } }).eq("id", drainStep.id);

    const result = await advance();
    expect(result.step).toBe("RETIRE_OLD_NODE");
    expect((await rows("device_node_assignments")).length).toBe(1); // never force-deleted, just no longer blocks
  });

  it("leaves the old node completely untouched if new-node provisioning fails permanently", async () => {
    db = makeFakeSupabase(replaceSeed({ oldState: "DEGRADED" }));
    ctx.supabase = db;
    provider.createInstance.mockRejectedValue(new Error("Hetzner API returned 503"));

    for (let i = 0; i < 8; i++) await advance(); // MAX_STEP_ATTEMPTS in fleet-operations.js

    const oldFinal = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
    expect(oldFinal.lifecycle_state).toBe("DEGRADED");
    expect(oldFinal.lifecycle_state_changed_at).toBeUndefined();
    expect(provider.destroyInstance).not.toHaveBeenCalled();
  });

  it("accepts a FAILED old node as a valid drain-start state", async () => {
    db = makeFakeSupabase(replaceSeed({ oldState: "FAILED" }));
    ctx.supabase = db;
    await driveNewNodeToReady();
    const result = await advance();
    expect(result.step).toBe("DRAIN_OLD_NODE");
    const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
    expect(old.lifecycle_state).toBe("DRAINING");
  });

  it("fails the step, not the new node, if the old node's state changed concurrently before draining", async () => {
    db = makeFakeSupabase(replaceSeed());
    ctx.supabase = db;
    await driveNewNodeToReady();
    // Simulate an admin quarantining the old node between MARK_READY and this tick.
    await db.from("nodes").update({ lifecycle_state: "QUARANTINED" }).eq("node_id", OLD_NODE_ID);

    const result = await advance();
    expect(result.status).toBe("FAILED");
    expect((await node()).lifecycle_state).toBe("READY"); // new node unaffected
    const old = (await rows("nodes")).find((n) => n.node_id === OLD_NODE_ID);
    expect(old.lifecycle_state).toBe("QUARANTINED"); // untouched, not silently overwritten
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- fleet-operations`
Expected: FAIL — `REPLACE_NODE_STEPS` is not exported, `advanceOperation` has no handler for type `REPLACE_NODE`.

- [ ] **Step 3: Implement REPLACE_NODE_STEPS, REPLACE_NODE_HANDLERS, startReplaceNodeOperation**

In `functions/lib/fleet-operations.js`, after the existing `CREATE_NODE_HANDLERS` object (before `const HANDLERS = { CREATE_NODE: CREATE_NODE_HANDLERS };`), add:

```js
export const DEFAULT_REPLACE_MAX_WAIT_HOURS = 72;
export const DRAIN_POLL_INTERVAL_S = 300;
// Buffer beyond CREATE_NODE_DEADLINE_MS + the drain wait, so the operation's
// own outer deadline_at is a pure safety net -- DRAIN_OLD_NODE's own
// drainDeadline is what actually forces the drain through on schedule.
const REPLACE_DEADLINE_BUFFER_MS = 60 * 60 * 1000;

export const REPLACE_NODE_STEPS = [...CREATE_NODE_STEPS, "DRAIN_OLD_NODE", "RETIRE_OLD_NODE"];

const REPLACE_NODE_HANDLERS = {
  ...CREATE_NODE_HANDLERS,

  async DRAIN_OLD_NODE({ supabase }, op, _newNode, step) {
    const oldNodeId = op.detail.oldNodeId;
    let drainDeadline = step.detail?.drainDeadline;

    if (!drainDeadline) {
      const { data: oldNode, error } = await supabase
        .from("nodes")
        .select("node_id, lifecycle_state")
        .eq("node_id", oldNodeId)
        .maybeSingle();
      if (error) throw new Error(`nodes lookup failed: ${error.message}`);
      if (!oldNode) throw new FatalStepError(`old node ${oldNodeId} no longer exists`);

      if (oldNode.lifecycle_state !== "DRAINING") {
        if (!canTransitionLifecycle(oldNode.lifecycle_state, "DRAINING")) {
          throw new FatalStepError(`old node ${oldNodeId} is ${oldNode.lifecycle_state}, cannot drain`);
        }
        const moved = await updateNode(
          supabase,
          oldNodeId,
          { lifecycle_state: "DRAINING", lifecycle_state_changed_at: new Date().toISOString() },
          { lifecycle_state: oldNode.lifecycle_state }
        );
        if (!moved) throw new FatalStepError(`old node ${oldNodeId} lifecycle changed concurrently`);
      }

      const maxWaitHours = op.detail.maxWaitHours ?? DEFAULT_REPLACE_MAX_WAIT_HOURS;
      drainDeadline = new Date(Date.now() + maxWaitHours * 60 * 60 * 1000).toISOString();
    }

    const { data: assignments, error: assignError } = await supabase
      .from("device_node_assignments")
      .select("device_id")
      .eq("node_id", oldNodeId);
    if (assignError) throw new Error(`device_node_assignments lookup failed: ${assignError.message}`);
    const remaining = (assignments ?? []).length;

    if (remaining === 0) return done({ drainDeadline, remaining: 0 });
    if (Date.now() > new Date(drainDeadline).getTime()) {
      return done({ drainDeadline, remaining, forced: true });
    }
    return wait(DRAIN_POLL_INTERVAL_S, { drainDeadline, remaining });
  },

  async RETIRE_OLD_NODE({ supabase, providers, env }, op) {
    const oldNodeId = op.detail.oldNodeId;
    const { data: oldNode, error } = await supabase
      .from("nodes")
      .select("node_id, lifecycle_state, provider, provider_instance_id")
      .eq("node_id", oldNodeId)
      .maybeSingle();
    if (error) throw new Error(`nodes lookup failed: ${error.message}`);
    if (!oldNode) throw new FatalStepError(`old node ${oldNodeId} no longer exists`);

    if (oldNode.lifecycle_state === "DRAINING") {
      const moved = await updateNode(
        supabase,
        oldNodeId,
        {
          lifecycle_state: "RETIRED",
          retired_at: new Date().toISOString(),
          lifecycle_state_changed_at: new Date().toISOString(),
        },
        { lifecycle_state: "DRAINING" }
      );
      if (!moved) throw new Error(`old node ${oldNodeId} lifecycle changed concurrently`);
    } else if (oldNode.lifecycle_state !== "RETIRED") {
      throw new FatalStepError(`old node ${oldNodeId} is ${oldNode.lifecycle_state}, expected DRAINING or RETIRED`);
    }

    if (oldNode.provider_instance_id) {
      const adapter = providers(oldNode.provider, env);
      await adapter.destroyInstance({ providerInstanceId: oldNode.provider_instance_id });
    }
    return done({ retired: true });
  },
};
```

Change the `HANDLERS` map:

```js
const HANDLERS = { CREATE_NODE: CREATE_NODE_HANDLERS, REPLACE_NODE: REPLACE_NODE_HANDLERS };
```

Add `startReplaceNodeOperation`, immediately after the existing `startCreateNodeOperation`:

```js
/**
 * Registers a PROVISIONING new node and its REPLACE_NODE operation (plus
 * steps) atomically via register_node_replace_operation(). Idempotent on
 * oldNodeId (not newNodeId): the operation's idempotency_key derives from
 * the OLD node, so a second replace attempt for the same old node fails
 * cleanly with 23505 regardless of what newNodeId it names.
 */
export async function startReplaceNodeOperation(
  supabase,
  { newNodeId, role, locationId, provider, region, hostname, oldNodeId, maxWaitHours = DEFAULT_REPLACE_MAX_WAIT_HOURS }
) {
  const deadlineMs = CREATE_NODE_DEADLINE_MS + maxWaitHours * 60 * 60 * 1000 + REPLACE_DEADLINE_BUFFER_MS;
  const { data: operation, error } = await supabase.rpc("register_node_replace_operation", {
    p_node_id: newNodeId,
    p_role: role,
    p_location_id: locationId,
    p_provider: provider,
    p_hostname: hostname,
    p_detail: { provider, region },
    p_old_node_id: oldNodeId,
    p_max_wait_hours: maxWaitHours,
    p_steps: REPLACE_NODE_STEPS,
    p_deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
  });
  if (error) return { error };
  return { operation };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npm test -- fleet-operations`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/fleet-operations.js functions/lib/__tests__/fleet-operations.test.js
git commit -m "feat(fleet): REPLACE_NODE operation type — drain and retire the old node"
```

---

### Task 4: Admin route — POST /api/admin/nodes/:id/replace

**Files:**
- Create: `functions/api/admin/nodes/[id]/replace.js`
- Test: `functions/api/admin/nodes/[id]/__tests__/replace.test.js`

**Interfaces:**
- Consumes: `startReplaceNodeOperation`, `advanceOperation`, `DEFAULT_REPLACE_MAX_WAIT_HOURS` (Task 3); `requireAdmin`, `writeAdminAudit`, `getProviderAdapter`, `getDnsAdapter`/`nodeHostname`, `fleetContext` (all pre-existing, same as `functions/api/admin/nodes.js`).
- Produces: `POST /api/admin/nodes/:id/replace` — `{ ok, oldNodeId, newNodeId, hostname, operationId, progress }` on 202; error shapes on 400/403/404/409/500.

- [ ] **Step 1: Write the failing tests**

Create `functions/api/admin/nodes/[id]/__tests__/replace.test.js`, mirroring `functions/api/admin/__tests__/nodes-create.test.js`'s mocking style:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const nodesMaybeSingle = vi.fn();
const auditInsert = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "nodes") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: nodesMaybeSingle };
      }
      if (table === "admin_audit_log") return { insert: auditInsert };
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

vi.mock("../../../../../lib/provider-adapter.js", () => ({
  getProviderAdapter: vi.fn((provider) => {
    if (provider !== "hetzner") throw new Error(`Unknown or unsupported provider: ${provider}`);
    return { name: "hetzner" };
  }),
}));

const startReplaceNodeOperation = vi.fn();
const advanceOperation = vi.fn();
vi.mock("../../../../../lib/fleet-operations.js", () => ({
  startReplaceNodeOperation,
  advanceOperation,
  DEFAULT_REPLACE_MAX_WAIT_HOURS: 72,
}));
vi.mock("../../../../../lib/dns-adapter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getDnsAdapter: vi.fn(() => ({ name: "cloudflare" })),
}));

const { onRequestPost } = await import("../replace.js");
const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0",
  SITE_URL: "https://arcana.example.test",
};

function makeRequest(body) {
  return new Request("https://example.test/api/admin/nodes/de-fsn-001/replace", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  nodesMaybeSingle.mockReset().mockResolvedValue({
    data: { node_id: "de-fsn-001", role: "EXIT", location_id: "loc-1", lifecycle_state: "READY", provider: "hetzner" },
    error: null,
  });
  auditInsert.mockReset().mockResolvedValue({ error: null });
  startReplaceNodeOperation.mockReset().mockResolvedValue({ operation: { id: "op-1" } });
  advanceOperation.mockReset().mockResolvedValue({ status: "RUNNING" });
});

describe("POST /api/admin/nodes/:id/replace", () => {
  it("returns 400 for an invalid newNodeId", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "BAD ID", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when region is missing", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the old node does not exist", async () => {
    nodesMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the old node is QUARANTINED", async () => {
    nodesMaybeSingle.mockResolvedValue({
      data: { node_id: "de-fsn-001", role: "EXIT", location_id: "loc-1", lifecycle_state: "QUARANTINED", provider: "hetzner" },
      error: null,
    });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(409);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("returns 409 when a replacement for this node is already in progress", async () => {
    startReplaceNodeOperation.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(409);
  });

  it("starts the replacement and returns 202 with the new node id and operation id", async () => {
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, oldNodeId: "de-fsn-001", newNodeId: "de-fsn-002", operationId: "op-1" });
    expect(startReplaceNodeOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newNodeId: "de-fsn-002",
        oldNodeId: "de-fsn-001",
        provider: "hetzner",
        region: "fsn1",
        role: "EXIT",
        locationId: "loc-1",
      })
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.node_replace_initiated", target_id: "de-fsn-001" })
    );
  });

  it("rejects a read-only admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: { role: "readonly" }, error: null });
    const res = await onRequestPost({
      env,
      request: makeRequest({ newNodeId: "de-fsn-002", region: "fsn1" }),
      params: { id: "de-fsn-001" },
    });
    expect(res.status).toBe(403);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });
});
```

Note: check `writeAdminAudit`'s actual column-naming convention (`target_id` vs `targetId`) against `functions/lib/admin-audit.js` before finalizing the last assertion — match whatever that helper's internal `.insert()` payload shape already is, consistent with how `admin.node_lifecycle_transition` is asserted elsewhere in the existing `lifecycle.test.js`.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- replace`
Expected: FAIL — `../replace.js` does not exist yet.

- [ ] **Step 3: Implement the route**

Create `functions/api/admin/nodes/[id]/replace.js`:

```js
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { getProviderAdapter } from "../../../../lib/provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "../../../../lib/dns-adapter.js";
import { startReplaceNodeOperation, advanceOperation, DEFAULT_REPLACE_MAX_WAIT_HOURS } from "../../../../lib/fleet-operations.js";
import { fleetContext } from "../../../../lib/fleet-context.js";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REPLACE_ELIGIBLE_STATES = new Set(["READY", "DEGRADED", "FAILED"]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Admin-initiated replace-node (spec 2026-09-25-fleet-phase12a). Provisions
 * a fresh node the same way POST /api/admin/nodes does, then hands the
 * combined workflow to REPLACE_NODE's saga: the reconciler (fleet-tick.js)
 * drains and retires the old node once the new one is verified READY. The
 * old node is validated eligible here but never written to by this route —
 * ordering safety belongs entirely to fleet-operations.js's DRAIN_OLD_NODE.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") {
    return jsonResponse({ error: "Read-only admins cannot perform this action" }, 403);
  }

  const oldNodeId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const newNodeId = typeof body?.newNodeId === "string" ? body.newNodeId.trim() : "";
  if (!NODE_ID_PATTERN.test(newNodeId)) {
    return jsonResponse({ error: "newNodeId must be lowercase alphanumeric/hyphen, 2-63 characters" }, 400);
  }
  if (newNodeId === oldNodeId) {
    return jsonResponse({ error: "newNodeId must differ from the node being replaced" }, 400);
  }
  const region = typeof body?.region === "string" && body.region ? body.region : null;
  if (!region) {
    return jsonResponse({ error: "region is required" }, 400);
  }
  let maxWaitHours = DEFAULT_REPLACE_MAX_WAIT_HOURS;
  if (body?.maxWaitHours !== undefined) {
    maxWaitHours = Number(body.maxWaitHours);
    if (!Number.isFinite(maxWaitHours) || maxWaitHours <= 0 || maxWaitHours > 720) {
      return jsonResponse({ error: "maxWaitHours must be a number between 1 and 720" }, 400);
    }
  }

  try {
    const { data: oldNode, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, role, location_id, lifecycle_state, provider")
      .eq("node_id", oldNodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!oldNode) return jsonResponse({ error: "Node not found" }, 404);
    if (!REPLACE_ELIGIBLE_STATES.has(oldNode.lifecycle_state)) {
      return jsonResponse({ error: `Cannot replace a node in state ${oldNode.lifecycle_state}` }, 409);
    }

    const provider = typeof body?.provider === "string" && body.provider ? body.provider : oldNode.provider;
    if (!provider) {
      return jsonResponse({ error: "provider is required (old node has none on record)" }, 400);
    }

    let hostname;
    try {
      getProviderAdapter(provider, env);
      hostname = nodeHostname(newNodeId, env);
      if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
      getDnsAdapter(env);
    } catch (err) {
      console.error("admin/nodes/:id/replace: fleet provisioning not configured:", err.message);
      return jsonResponse({ error: `Provider ${provider} is not available` }, 400);
    }

    const { operation, error } = await startReplaceNodeOperation(supabaseAdmin, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider,
      region,
      hostname,
      oldNodeId,
      maxWaitHours,
    });
    if (error) {
      if (error.code === "23505") {
        return jsonResponse(
          { error: "A replacement for this node is already in progress, or newNodeId already exists" },
          409
        );
      }
      if (error.code === "23503") {
        return jsonResponse({ error: "locationId does not exist" }, 400);
      }
      throw new Error(`register_node_replace_operation failed: ${error.message}`);
    }

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.node_replace_initiated",
      targetType: "node",
      targetId: oldNodeId,
      metadata: { oldNodeId, newNodeId, operationId: operation.id, provider, region, maxWaitHours },
    });

    let progress = null;
    try {
      progress = await advanceOperation(fleetContext(supabaseAdmin, env), operation);
    } catch (err) {
      // Not an error for the caller: the reconciler resumes the operation.
      console.error("admin/nodes/:id/replace: inline advance failed:", err.message);
    }

    return jsonResponse({ ok: true, oldNodeId, newNodeId, hostname, operationId: operation.id, progress }, 202);
  } catch (err) {
    console.error("admin/nodes/:id/replace: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- replace`
Expected: PASS. If the audit-log assertion's column names don't match, fix the test (not the route) to match `admin-audit.js`'s real payload shape.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/api/admin/nodes/[id]/replace.js functions/api/admin/nodes/[id]/__tests__/replace.test.js
git commit -m "feat(fleet): admin POST /api/admin/nodes/:id/replace"
```

---

### Task 5: Auto-trigger — node-auto-replace.js and fleet-tick.js wiring

**Files:**
- Create: `functions/lib/node-auto-replace.js`
- Modify: `functions/api/internal/fleet-tick.js`
- Test: `functions/lib/__tests__/node-auto-replace.test.js`, `functions/api/internal/__tests__/fleet-tick.test.js`

**Interfaces:**
- Consumes: `startReplaceNodeOperation` (Task 3); `getProviderAdapter`, `getDnsAdapter`/`nodeHostname` (pre-existing); `nodes.lifecycle_state_changed_at` (Task 1, guaranteed set by Task 2).
- Produces: `autoReplaceFailedNodes(supabase, env) -> Promise<Array<{ oldNodeId, newNodeId, operationId }>>`, called from `fleet-tick.js`'s `onRequestPost` when `env.FEATURE_AUTO_NODE_REPLACE === "true"`.

- [ ] **Step 1: Write the failing tests for node-auto-replace.js**

Create `functions/lib/__tests__/node-auto-replace.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { autoReplaceFailedNodes } from "../node-auto-replace.js";

vi.mock("../provider-adapter.js", () => ({
  getProviderAdapter: vi.fn((provider) => {
    if (provider !== "hetzner") throw new Error(`Unknown or unsupported provider: ${provider}`);
    return { name: "hetzner" };
  }),
}));
vi.mock("../dns-adapter.js", () => ({
  getDnsAdapter: vi.fn(() => ({ name: "cloudflare" })),
  nodeHostname: vi.fn((nodeId) => `${nodeId}.nodes.example.test`),
}));

const startReplaceNodeOperation = vi.fn();
vi.mock("../fleet-operations.js", () => ({ startReplaceNodeOperation }));

const baseEnv = {
  FLEET_AUTO_REPLACE_REGION: "fsn1",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0",
  AUTO_REPLACE_AFTER_FAILED_MS: String(60 * 60 * 1000),
};

const OLD = {
  node_id: "de-fsn-001",
  role: "EXIT",
  location_id: "loc-1",
  provider: "hetzner",
  lifecycle_state: "FAILED",
  lifecycle_state_changed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
};

beforeEach(() => {
  startReplaceNodeOperation.mockReset().mockResolvedValue({ operation: { id: "op-1" } });
});

describe("autoReplaceFailedNodes", () => {
  it("starts a replacement for a node FAILED longer than the threshold", async () => {
    const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([{ oldNodeId: "de-fsn-001", newNodeId: "de-fsn-001-r1", operationId: "op-1" }]);
    expect(startReplaceNodeOperation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ oldNodeId: "de-fsn-001", newNodeId: "de-fsn-001-r1", provider: "hetzner", region: "fsn1" })
    );
  });

  it("skips a node FAILED for less than the threshold", async () => {
    const recent = { ...OLD, lifecycle_state_changed_at: new Date().toISOString() };
    const db = makeFakeSupabase({ nodes: [recent], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("skips a node that already has a REPLACE_NODE operation", async () => {
    const db = makeFakeSupabase({
      nodes: [OLD],
      fleet_operations: [{ id: "op-existing", type: "REPLACE_NODE", idempotency_key: "REPLACE_NODE:de-fsn-001" }],
    });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("no-ops without crashing when FLEET_AUTO_REPLACE_REGION is not configured", async () => {
    const db = makeFakeSupabase({ nodes: [OLD], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, { ...baseEnv, FLEET_AUTO_REPLACE_REGION: undefined });
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });

  it("skips a node with no provider on record", async () => {
    const noProvider = { ...OLD, provider: null };
    const db = makeFakeSupabase({ nodes: [noProvider], fleet_operations: [] });
    const started = await autoReplaceFailedNodes(db, baseEnv);
    expect(started).toEqual([]);
    expect(startReplaceNodeOperation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- node-auto-replace`
Expected: FAIL — `../node-auto-replace.js` does not exist.

- [ ] **Step 3: Implement node-auto-replace.js**

Create `functions/lib/node-auto-replace.js`:

```js
import { getProviderAdapter } from "./provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "./dns-adapter.js";
import { startReplaceNodeOperation } from "./fleet-operations.js";

const REPLACEMENT_SUFFIX_PATTERN = /^(.*)-r(\d+)$/;

/**
 * Names the replacement node de-fsn-001 -> de-fsn-001-r1 -> de-fsn-001-r2
 * etc. (an already-replaced-once node id matching the suffix pattern bumps
 * the counter instead of doubling it), so operators can see replacement
 * lineage directly in the node id without a separate column for it.
 */
function nextReplacementNodeId(oldNodeId) {
  const match = oldNodeId.match(REPLACEMENT_SUFFIX_PATTERN);
  if (match) return `${match[1]}-r${Number(match[2]) + 1}`;
  return `${oldNodeId}-r1`;
}

/**
 * Phase 12a auto-trigger (functions/api/internal/fleet-tick.js), gated by
 * the caller checking FEATURE_AUTO_NODE_REPLACE. Finds nodes FAILED longer
 * than AUTO_REPLACE_AFTER_FAILED_MS with no existing REPLACE_NODE operation
 * (checked directly against fleet_operations' idempotency_key, not by
 * attempting the insert and catching 23505 -- avoids a noisy unique
 * violation every tick for a node already mid-replacement) and starts one
 * for each, exactly the way the admin route does.
 *
 * Requires FLEET_AUTO_REPLACE_REGION: unlike the admin route, there is no
 * human supplying a provisioning region per call, and region is not stored
 * on any node row. No-ops (logs and returns []) rather than throwing when
 * unconfigured, since this runs inside fleet-tick's shared request
 * alongside unrelated operation advances and account-deletion finalization
 * that must not be interrupted by a misconfiguration here.
 */
export async function autoReplaceFailedNodes(supabase, env) {
  const thresholdMs = Number(env.AUTO_REPLACE_AFTER_FAILED_MS);
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return [];
  const region = env.FLEET_AUTO_REPLACE_REGION;
  if (!region) {
    console.error("node-auto-replace: FLEET_AUTO_REPLACE_REGION is not configured");
    return [];
  }

  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data: candidates, error } = await supabase
    .from("nodes")
    .select("node_id, role, location_id, provider, lifecycle_state_changed_at")
    .eq("lifecycle_state", "FAILED")
    .lte("lifecycle_state_changed_at", cutoff);
  if (error) {
    console.error("node-auto-replace: candidate query failed:", error.message);
    return [];
  }
  if (!candidates || candidates.length === 0) return [];

  const keys = candidates.map((n) => `REPLACE_NODE:${n.node_id}`);
  const { data: existingOps, error: opsError } = await supabase
    .from("fleet_operations")
    .select("idempotency_key")
    .in("idempotency_key", keys);
  if (opsError) {
    console.error("node-auto-replace: existing-operation query failed:", opsError.message);
    return [];
  }
  const alreadyReplacing = new Set((existingOps ?? []).map((o) => o.idempotency_key));

  const started = [];
  for (const oldNode of candidates) {
    const key = `REPLACE_NODE:${oldNode.node_id}`;
    if (alreadyReplacing.has(key)) continue;
    if (!oldNode.provider) {
      console.error(`node-auto-replace: node ${oldNode.node_id} has no provider on record, skipping`);
      continue;
    }

    let hostname;
    try {
      getProviderAdapter(oldNode.provider, env);
      if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
      getDnsAdapter(env);
      hostname = nodeHostname(nextReplacementNodeId(oldNode.node_id), env);
    } catch (err) {
      console.error(`node-auto-replace: provisioning not configured for ${oldNode.provider}:`, err.message);
      continue;
    }

    const newNodeId = nextReplacementNodeId(oldNode.node_id);
    const { operation, error: startError } = await startReplaceNodeOperation(supabase, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider: oldNode.provider,
      region,
      hostname,
      oldNodeId: oldNode.node_id,
    });
    if (startError) {
      if (startError.code !== "23505") {
        console.error(`node-auto-replace: failed to start replacement for ${oldNode.node_id}:`, startError.message);
      }
      continue;
    }
    started.push({ oldNodeId: oldNode.node_id, newNodeId, operationId: operation.id });
  }
  return started;
}
```

- [ ] **Step 4: Run to verify the new tests pass**

Run: `npm test -- node-auto-replace`
Expected: PASS.

- [ ] **Step 5: Write the failing fleet-tick.js wiring test**

Find `functions/api/internal/__tests__/fleet-tick.test.js`'s existing mock setup (it likely mocks `../../../lib/fleet-operations.js` and `../../../lib/fleet-context.js` already — read the file first to match its exact mocking style) and add:

```js
const autoReplaceFailedNodes = vi.fn();
vi.mock("../../../lib/node-auto-replace.js", () => ({ autoReplaceFailedNodes }));

// ...inside beforeEach, alongside the file's existing resets:
autoReplaceFailedNodes.mockReset().mockResolvedValue([]);

it("calls autoReplaceFailedNodes and includes its result when FEATURE_AUTO_NODE_REPLACE is true", async () => {
  autoReplaceFailedNodes.mockResolvedValue([{ oldNodeId: "n1", newNodeId: "n1-r1", operationId: "op-9" }]);
  const res = await onRequestPost({
    env: { ...env, FEATURE_AUTO_NODE_REPLACE: "true" },
    request: makeRequest(),
  });
  const body = await res.json();
  expect(autoReplaceFailedNodes).toHaveBeenCalled();
  expect(body.autoReplaced).toEqual([{ oldNodeId: "n1", newNodeId: "n1-r1", operationId: "op-9" }]);
});

it("does not call autoReplaceFailedNodes when the flag is unset", async () => {
  const res = await onRequestPost({ env, request: makeRequest() });
  await res.json();
  expect(autoReplaceFailedNodes).not.toHaveBeenCalled();
});

it("does not fail the tick if autoReplaceFailedNodes throws", async () => {
  autoReplaceFailedNodes.mockRejectedValue(new Error("boom"));
  const res = await onRequestPost({ env: { ...env, FEATURE_AUTO_NODE_REPLACE: "true" }, request: makeRequest() });
  expect(res.status).toBe(200);
});
```

(Adapt `makeRequest()`/`env`/`onRequestPost` import to whatever names the existing test file already uses — read it first rather than guessing, since this task only adds to an existing suite.)

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- fleet-tick`
Expected: FAIL — `body.autoReplaced` is `undefined`, or the mock is never called.

- [ ] **Step 7: Wire it into fleet-tick.js**

In `functions/api/internal/fleet-tick.js`, add the import:

```js
import { autoReplaceFailedNodes } from "../../lib/node-auto-replace.js";
```

After the existing `finalizeAccountDeletions` block and before the final `return json(...)`, add:

```js
  let autoReplaced = [];
  if (env.FEATURE_AUTO_NODE_REPLACE === "true") {
    try {
      autoReplaced = await autoReplaceFailedNodes(supabaseAdmin, env);
    } catch (err) {
      console.error("fleet-tick: auto-replace failed:", err.message);
    }
  }
  return json({ leased: results.length, results, deletedAccounts, autoReplaced });
```

(This replaces the existing final `return json({ leased: results.length, results, deletedAccounts });` line.)

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- fleet-tick`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add functions/lib/node-auto-replace.js functions/lib/__tests__/node-auto-replace.test.js functions/api/internal/fleet-tick.js functions/api/internal/__tests__/fleet-tick.test.js
git commit -m "feat(fleet): auto-replace sustained-FAILED nodes behind FEATURE_AUTO_NODE_REPLACE"
```

---

### Task 6: Staging verification (manual — requires live infrastructure access)

**Files:** none (operational verification, not code).

This task cannot be executed by an automated implementer or subagent — it requires an account with real provider/DNS credentials against the staging environment, per the fleet plan's standing requirement that data-plane claims be verified against real infrastructure rather than assumed from code review (spec §5, mirroring Phase 8's own staging-verification task).

- [ ] **Step 1:** In staging, trigger `POST /api/admin/nodes/de-fsn-999/replace` (or an equivalent real node id) with a valid `newNodeId`/`region` against a real `READY` node with at least one real device assignment.
- [ ] **Step 2:** Confirm via the admin Jobs view that the new node reaches `READY` (all six `CREATE_NODE` steps complete) before the old node's `lifecycle_state` changes at all.
- [ ] **Step 3:** Confirm the old node transitions to `DRAINING`, and that its assigned device(s) land on the new node once they naturally reconnect (no forced disconnect).
- [ ] **Step 4:** Confirm the old node reaches `RETIRED` once its assignments clear, `retired_at` is set, and the provider instance is actually gone (check the provider's own console/API, not just the DB row).
- [ ] **Step 5:** Separately, with `FEATURE_AUTO_NODE_REPLACE` and `FLEET_AUTO_REPLACE_REGION` set in staging, force a real node to `FAILED` (e.g. stop its sing-box process, same as Phase 8's staging check) and confirm `fleet-tick` starts a `REPLACE_NODE` operation automatically once `AUTO_REPLACE_AFTER_FAILED_MS` elapses.
- [ ] **Step 6:** Report results back; if any step fails, file it as a bug against this plan's tasks rather than editing staging state by hand.
