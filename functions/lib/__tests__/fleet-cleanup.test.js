import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import {
  advanceOperation,
  CLEANUP_ABANDONED_NODE_STEPS,
  CLEANUP_FAILED_STALE_MS,
  startCleanupAbandonedNodeOperation,
  findAbandonedNodeCandidates,
} from "../fleet-operations.js";
import { runAbandonedNodeCleanup } from "../fleet-cleanup.js";
import { authenticateNode } from "../node-auth.js";

const NODE_ID = "de-fsn-abandoned-1";
const STALE_CHANGED_AT = new Date(Date.now() - CLEANUP_FAILED_STALE_MS - 60_000).toISOString();

function baseNode(overrides = {}) {
  return {
    node_id: NODE_ID,
    role: "EXIT",
    lifecycle_state: "FAILED",
    lifecycle_state_changed_at: STALE_CHANGED_AT,
    hostname: `${NODE_ID}.nodes.example.test`,
    provider: "hetzner",
    provider_instance_id: "instance-1",
    provider_instance_destroyed_at: null,
    ip_address: "198.51.100.5",
    dns_record_id: "rec-1",
    dns_removed_at: null,
    revoked_at: null,
    api_key_hash: "somehash",
    last_seen_at: null,
    ...overrides,
  };
}

// A minimal, faithful-enough fake of revoke_node_key_and_transition (real
// impl: supabase/migrations/20261008000000_admin_audit_transactional.sql)
// -- just the parts this saga's REVOKE_AND_RETIRE step depends on: the
// expected_from_state optimistic-concurrency guard, and revoking the key
// atomically with the lifecycle transition.
//
// NOTE: makeFakeSupabase deep-clones whatever seed object it's given, so
// this (and the register_cleanup_operation fake below) MUST mutate the
// `tables` object handed to them at call time by fake-supabase's rpc()
// dispatcher, never an outer closure's reference to the original seed --
// that outer object is a different, disconnected array after cloning.
function revokeRpc(args, tables) {
  const node = tables.nodes.find((n) => n.node_id === args.p_node_id);
  if (!node) return { data: { status: "not_found" }, error: null };
  if (node.lifecycle_state !== args.p_expected_from_state) {
    return { data: { status: "stale", lifecycle_state: node.lifecycle_state }, error: null };
  }
  if (args.p_to_state === "RETIRED" && !node.dns_removed_at && !args.p_override_dns_check) {
    return { data: { status: "dns_not_removed" }, error: null };
  }
  Object.assign(node, {
    lifecycle_state: args.p_to_state,
    lifecycle_state_changed_at: new Date().toISOString(),
    revoked_at: new Date().toISOString(),
    api_key_hash: null,
    retired_at: args.p_to_state === "RETIRED" ? new Date().toISOString() : node.retired_at,
  });
  return { data: { status: "ok", jobs_cancelled: 0, lease_slots_deleted: 0 }, error: null };
}

// Fake of register_cleanup_operation (real impl:
// supabase/migrations/20261011000000_node_cleanup.sql) -- idempotent on
// node_id via the same idempotency_key shape.
function registerCleanupRpc(args, tables) {
  const key = `CLEANUP_ABANDONED_NODE:${args.p_node_id}`;
  const existing = tables.fleet_operations.find((o) => o.idempotency_key === key);
  if (existing) return { data: existing, error: null };
  const op = {
    id: `op-cleanup-${args.p_node_id}`,
    type: "CLEANUP_ABANDONED_NODE",
    status: "RUNNING",
    node_id: args.p_node_id,
    attempts: 0,
    detail: {},
    idempotency_key: key,
    deadline_at: args.p_deadline_at,
  };
  tables.fleet_operations.push(op);
  args.p_steps.forEach((name, i) => {
    tables.operation_steps.push({
      id: tables.operation_steps.length + 1,
      operation_id: op.id,
      step_index: i,
      name,
      status: "PENDING",
      attempts: 0,
      detail: {},
    });
  });
  return { data: op, error: null };
}

function seedWithRpc(nodeOverrides = {}, { assignments = [] } = {}) {
  const seed = {
    nodes: [baseNode(nodeOverrides)],
    fleet_operations: [],
    operation_steps: [],
    device_node_assignments: assignments,
  };
  return makeFakeSupabase(seed, {
    rpc: {
      revoke_node_key_and_transition: revokeRpc,
      register_cleanup_operation: registerCleanupRpc,
    },
  });
}

let db, provider, dnsAdapter;

beforeEach(() => {
  provider = { destroyInstance: vi.fn().mockResolvedValue(undefined) };
  dnsAdapter = { deleteRecord: vi.fn().mockResolvedValue(undefined), recordExists: vi.fn().mockResolvedValue(false) };
});

async function driveToCompletion(supabase, nodeId, maxTicks = 10) {
  const ctxLocal = { supabase, env: {}, providers: vi.fn(() => provider), dns: vi.fn(() => dnsAdapter) };
  const { operation } = await startCleanupAbandonedNodeOperation(supabase, { nodeId });
  let outcome;
  for (let i = 0; i < maxTicks; i++) {
    const { data: op } = await supabase.from("fleet_operations").select("*").eq("id", operation.id).maybeSingle();
    outcome = await advanceOperation(ctxLocal, op ?? operation);
    if (outcome.status !== "RUNNING") break;
  }
  return outcome;
}

describe("CLEANUP_ABANDONED_NODE saga", () => {
  it("has the four expected steps in order", () => {
    expect(CLEANUP_ABANDONED_NODE_STEPS).toEqual(["VERIFY_ELIGIBLE", "REMOVE_DNS", "REVOKE_AND_RETIRE", "DESTROY_INSTANCE"]);
  });

  // Safety-critical: a node with a live assignment must never be destroyed,
  // no matter how stale/degraded it looks. VERIFY_ELIGIBLE
  // (functions/lib/fleet-operations.js) is the sole gate every later step
  // depends on.
  it("never destroys a node with live device_node_assignments, even FAILED and stale", async () => {
    db = seedWithRpc({}, { assignments: [{ device_id: "dev-1", node_id: NODE_ID, hop: "EXIT" }] });
    const outcome = await driveToCompletion(db, NODE_ID, 1);
    expect(outcome.status).toBe("RUNNING");
    expect(outcome.step).toBe("VERIFY_ELIGIBLE");
    expect(provider.destroyInstance).not.toHaveBeenCalled();
    expect(dnsAdapter.deleteRecord).not.toHaveBeenCalled();
    const { data: node } = await db.from("nodes").select("*").eq("node_id", NODE_ID).maybeSingle();
    expect(node.lifecycle_state).toBe("FAILED");
    expect(node.revoked_at).toBeFalsy();
  });

  it("aborts fatally if the node recovered (no longer FAILED/RETIRED) before cleanup ran", async () => {
    db = seedWithRpc({ lifecycle_state: "READY" });
    const outcome = await driveToCompletion(db, NODE_ID, 1);
    expect(outcome.status).toBe("FAILED");
    expect(provider.destroyInstance).not.toHaveBeenCalled();
  });

  it("removes DNS, revokes the credential, retires, and destroys the instance for an abandoned FAILED node", async () => {
    db = seedWithRpc();
    const outcome = await driveToCompletion(db, NODE_ID);
    expect(outcome.status).toBe("COMPLETED");

    expect(dnsAdapter.deleteRecord).toHaveBeenCalledWith({ recordId: "rec-1", name: `${NODE_ID}.nodes.example.test`, type: "A" });
    expect(provider.destroyInstance).toHaveBeenCalledWith({ providerInstanceId: "instance-1" });

    const { data: node } = await db.from("nodes").select("*").eq("node_id", NODE_ID).maybeSingle();
    expect(node.lifecycle_state).toBe("RETIRED");
    expect(node.dns_removed_at).toBeTruthy();
    expect(node.revoked_at).toBeTruthy();
    expect(node.api_key_hash).toBeNull();
    expect(node.provider_instance_destroyed_at).toBeTruthy();

    // F-05 integration: the revoked credential must actually be rejected by
    // node-auth.js, not just have a DB flag flipped.
    const authRequest = new Request("https://example.test/api/agent/claim", {
      method: "POST",
      headers: { Authorization: "Bearer whatever" },
    });
    const authSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: node, error: null }),
          }),
        }),
      }),
    };
    expect(await authenticateNode(authRequest, authSupabase)).toBeNull();
  });

  it("is idempotent: DNS delete and instance destroy each run exactly once across repeated advances", async () => {
    db = seedWithRpc();
    await driveToCompletion(db, NODE_ID);
    // Re-register (same idempotency_key) and advance again -- simulates a
    // second sweep tick finding the same now-RETIRED node.
    const outcome2 = await driveToCompletion(db, NODE_ID);
    expect(outcome2.status).toBe("COMPLETED");
    expect(dnsAdapter.deleteRecord).toHaveBeenCalledTimes(1);
    expect(provider.destroyInstance).toHaveBeenCalledTimes(1);
  });

  it("resumes correctly after a partial failure (retry-safe): a transient destroy error doesn't repeat DNS/revoke work", async () => {
    db = seedWithRpc();
    provider.destroyInstance.mockRejectedValueOnce(new Error("transient Hetzner 503"));
    const ctxLocal = { supabase: db, env: {}, providers: vi.fn(() => provider), dns: vi.fn(() => dnsAdapter) };
    const { operation } = await startCleanupAbandonedNodeOperation(db, { nodeId: NODE_ID });

    // First advance: VERIFY_ELIGIBLE, REMOVE_DNS, REVOKE_AND_RETIRE all
    // complete; DESTROY_INSTANCE throws and is retried (not fatal), so the
    // operation is left RUNNING at that step, not FAILED.
    const outcome = await advanceOperation(ctxLocal, operation);
    expect(outcome.status).toBe("RUNNING");
    expect(outcome.step).toBe("DESTROY_INSTANCE");
    expect(dnsAdapter.deleteRecord).toHaveBeenCalledTimes(1);

    // Retry: succeeds, and no earlier step re-ran its side effect.
    const { data: refreshed2 } = await db.from("fleet_operations").select("*").eq("id", operation.id).maybeSingle();
    const finalOutcome = await advanceOperation(ctxLocal, refreshed2);
    expect(finalOutcome.status).toBe("COMPLETED");
    expect(dnsAdapter.deleteRecord).toHaveBeenCalledTimes(1);
    expect(provider.destroyInstance).toHaveBeenCalledTimes(2); // first threw, second succeeded
  });

  it("defensively revokes a RETIRED node's credential if it somehow still has one (pre-F-05 row)", async () => {
    db = seedWithRpc({ lifecycle_state: "RETIRED", dns_removed_at: new Date().toISOString(), revoked_at: null });
    const outcome = await driveToCompletion(db, NODE_ID);
    expect(outcome.status).toBe("COMPLETED");
    const { data: node } = await db.from("nodes").select("*").eq("node_id", NODE_ID).maybeSingle();
    expect(node.revoked_at).toBeTruthy();
    expect(node.api_key_hash).toBeNull();
    expect(provider.destroyInstance).toHaveBeenCalledWith({ providerInstanceId: "instance-1" });
  });
});

describe("findAbandonedNodeCandidates", () => {
  it("finds a stale FAILED node but not a freshly-FAILED one", async () => {
    const fresh = { ...baseNode({}), node_id: "fresh-1", lifecycle_state_changed_at: new Date().toISOString() };
    const stale = baseNode({});
    db = makeFakeSupabase({ nodes: [fresh, stale], device_node_assignments: [] });
    const candidates = await findAbandonedNodeCandidates(db, { now: Date.now() });
    expect(candidates.map((n) => n.node_id)).toEqual([NODE_ID]);
  });

  it("finds a RETIRED node whose provider instance was never destroyed", async () => {
    const retired = baseNode({ lifecycle_state: "RETIRED", dns_removed_at: new Date().toISOString() });
    db = makeFakeSupabase({ nodes: [retired], device_node_assignments: [] });
    const candidates = await findAbandonedNodeCandidates(db, { now: Date.now() });
    expect(candidates.map((n) => n.node_id)).toEqual([NODE_ID]);
  });

  it("excludes a RETIRED node whose instance is already confirmed destroyed", async () => {
    const done = baseNode({
      lifecycle_state: "RETIRED",
      dns_removed_at: new Date().toISOString(),
      provider_instance_destroyed_at: new Date().toISOString(),
    });
    db = makeFakeSupabase({ nodes: [done], device_node_assignments: [] });
    const candidates = await findAbandonedNodeCandidates(db, { now: Date.now() });
    expect(candidates).toEqual([]);
  });
});

describe("runAbandonedNodeCleanup dry-run mode", () => {
  it("makes zero mutations and reports an eligible node accurately", async () => {
    db = seedWithRpc();
    const before = JSON.parse(JSON.stringify(await db.from("nodes").select("*")));
    const report = await runAbandonedNodeCleanup(db, {}, { dryRun: true });
    const after = await db.from("nodes").select("*");
    expect(after).toEqual(before);
    // No operation was ever registered either.
    const { data: ops } = await db.from("fleet_operations").select("*");
    expect(ops).toEqual([]);

    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ nodeId: NODE_ID, eligible: true });
    expect(report[0].plannedActions).toEqual(
      expect.arrayContaining(["dns_removal", "credential_revocation", "provider_instance_destroy"])
    );
    expect(report[0].operation).toBeUndefined();
  });

  it("reports a node with live assignments as ineligible, with the reason, and still mutates nothing", async () => {
    db = seedWithRpc({}, { assignments: [{ device_id: "dev-1", node_id: NODE_ID, hop: "EXIT" }] });
    const report = await runAbandonedNodeCleanup(db, {}, { dryRun: true });
    expect(report).toHaveLength(1);
    expect(report[0].eligible).toBe(false);
    expect(report[0].reason).toMatch(/live device assignment/);
    const { data: ops } = await db.from("fleet_operations").select("*");
    expect(ops).toEqual([]);
  });
});

describe("runAbandonedNodeCleanup live mode", () => {
  it("registers and advances the saga for an eligible node", async () => {
    db = seedWithRpc();
    const report = await runAbandonedNodeCleanup(db, {}, { dryRun: false, providers: vi.fn(() => provider), dns: vi.fn(() => dnsAdapter) });
    expect(report).toHaveLength(1);
    expect(report[0].eligible).toBe(true);
    // advanceOperation runs every step it can in one call; with this test's
    // mocks none of them wait, so the whole saga completes in this single
    // sweep pass.
    expect(report[0].operation.status).toBe("COMPLETED");
    const { data: ops } = await db.from("fleet_operations").select("*");
    expect(ops).toHaveLength(1);
    const { data: node } = await db.from("nodes").select("*").eq("node_id", NODE_ID).maybeSingle();
    expect(node.lifecycle_state).toBe("RETIRED");
  });

  it("never advances a node with live assignments", async () => {
    db = seedWithRpc({}, { assignments: [{ device_id: "dev-1", node_id: NODE_ID, hop: "EXIT" }] });
    const report = await runAbandonedNodeCleanup(db, {}, { dryRun: false, providers: vi.fn(() => provider), dns: vi.fn(() => dnsAdapter) });
    expect(report[0].eligible).toBe(false);
    expect(dnsAdapter.deleteRecord).not.toHaveBeenCalled();
    const { data: ops } = await db.from("fleet_operations").select("*");
    expect(ops).toEqual([]);
  });
});
