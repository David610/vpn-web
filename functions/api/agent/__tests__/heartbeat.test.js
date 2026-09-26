import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nodeMaybeSingle = vi.fn();
const nodesUpdate = vi.fn();
const alertsInsert = vi.fn();
const nodesListSelect = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === "nodes") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: nodeMaybeSingle,
          update: nodesUpdate,
          in: vi.fn().mockReturnThis(),
          neq: vi.fn((...args) => nodesListSelect(...args)),
        };
      }
      if (table === "operational_alerts") {
        return {
          insert: alertsInsert,
          update: vi.fn(() => alertResolveChain()),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

// Chainable + awaitable, like a real PostgREST builder: records every
// filter applied so tests can assert on guards. A compare-and-set write
// ends in .select().maybeSingle(); casMatches decides whether its filters
// "matched" a row (false simulates losing the race to a concurrent write).
const updateChains = [];
let casMatches = true;
function updateChain() {
  const chain = { filters: [] };
  for (const op of ["eq", "neq", "not"]) {
    chain[op] = vi.fn((...args) => {
      chain.filters.push([op, ...args]);
      return chain;
    });
  }
  chain.select = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: casMatches ? { node_id: "matched" } : null, error: null })
  );
  chain.then = (resolve) => resolve({ error: null });
  updateChains.push(chain);
  return chain;
}

const alertResolveChains = [];
function alertResolveChain() {
  const chain = { filters: [] };
  chain.eq = vi.fn((...args) => {
    chain.filters.push(args);
    return chain;
  });
  chain.then = (resolve) => resolve({ error: null });
  alertResolveChains.push(chain);
  return chain;
}
function resolvedDedupKeys() {
  return alertResolveChains.map((c) => c.filters.find(([col]) => col === "dedup_key")?.[1]);
}
function insertedDedupKeys() {
  return alertsInsert.mock.calls.map(([row]) => row.dedup_key);
}

const applyProtocolReport = vi.fn(async () => ({ rows: 0, transitions: [] }));
vi.mock("../../../lib/protocol-health-store.js", () => ({ applyProtocolReport: (...a) => applyProtocolReport(...a) }));

const { onRequestPost } = await import("../heartbeat.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(body) {
  return new Request("https://example.test/api/agent/heartbeat", {
    method: "POST",
    headers: { Authorization: "Bearer node-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  nodeMaybeSingle.mockReset().mockResolvedValue({ data: { node_id: "node-1", revoked_at: null }, error: null });
  nodesUpdate.mockReset().mockImplementation(() => updateChain());
  alertsInsert.mockReset().mockResolvedValue({ error: null });
  nodesListSelect.mockReset().mockResolvedValue({ data: [], error: null });
  updateChains.length = 0;
  alertResolveChains.length = 0;
  casMatches = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/agent/heartbeat observed_revision", () => {
  it("includes observed_revision in the update when provided", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: 3 }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ observed_revision: 3 });
  });

  it("omits observed_revision entirely rather than coercing to 0 when absent", async () => {
    // An agent build that doesn't report this yet must never look like it
    // just rolled back to revision zero.
    await onRequestPost({ env, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");
  });

  it("omits observed_revision when it is negative or non-integer", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: -1 }) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");

    nodesUpdate.mockClear();
    await onRequestPost({ env, request: makeRequest({ observed_revision: 1.5 }) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("observed_revision");
  });

  it("accepts observed_revision of 0 (a node's initial state)", async () => {
    await onRequestPost({ env, request: makeRequest({ observed_revision: 0 }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ observed_revision: 0 });
  });
});

describe("POST /api/agent/heartbeat — Phase 8 health transitions", () => {
  const autoEnv = { ...env, FEATURE_AUTO_NODE_HEALTH: "true" };

  function mockNode(overrides) {
    nodeMaybeSingle.mockResolvedValue({
      data: {
        node_id: "node-1",
        revoked_at: null,
        lifecycle_state: "READY",
        consecutive_probe_failures: 0,
        consecutive_probe_successes: 0,
        last_seen_at: new Date().toISOString(),
        ...overrides,
      },
      error: null,
    });
  }

  // Every nodes update that wrote lifecycle_state, with its filters.
  function lifecycleWrites() {
    return nodesUpdate.mock.calls
      .map(([patch], i) => ({ patch, filters: updateChains[i].filters }))
      .filter(({ patch }) => "lifecycle_state" in patch);
  }

  function casWrite(nodeId, from, to, failedReason = null) {
    return {
      patch: { lifecycle_state: to, lifecycle_state_changed_at: expect.any(String), failed_reason: failedReason },
      filters: [
        ["eq", "node_id", nodeId],
        ["eq", "lifecycle_state", from],
      ],
    };
  }

  const stale = () => new Date(Date.now() - 999_999_999).toISOString();

  it("stores probe_ok=null as last_probe_ok null, not false, and does not transition", async () => {
    mockNode({});
    await onRequestPost({ env: autoEnv, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ last_probe_ok: null });
    expect(lifecycleWrites()).toEqual([]);
  });

  it("stamps last_probe_at only when a probe result actually arrived", async () => {
    mockNode({});
    await onRequestPost({ env: autoEnv, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("last_probe_at");

    nodesUpdate.mockClear();
    updateChains.length = 0;
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false }) });
    expect(typeof nodesUpdate.mock.calls[0][0].last_probe_at).toBe("string");
  });

  it("transitions READY to DEGRADED after 3 consecutive failed probes, compare-and-set on READY", async () => {
    mockNode({ consecutive_probe_failures: 2 });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false }) });
    const telemetry = nodesUpdate.mock.calls[0][0];
    expect(telemetry).toMatchObject({ consecutive_probe_failures: 3 });
    expect(telemetry).not.toHaveProperty("lifecycle_state");
    expect(lifecycleWrites()).toEqual([casWrite("node-1", "READY", "DEGRADED")]);
  });

  it("still records telemetry and streaks when the lifecycle compare-and-set loses the race", async () => {
    mockNode({ consecutive_probe_failures: 2 });
    casMatches = false;
    const res = await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false, cpu_percent: 5 }) });
    expect(res.status).toBe(200);
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ consecutive_probe_failures: 3, cpu_percent: 5 });
    // The resulting state is unknown (someone else's write won), so no
    // DEGRADED alert is raised off a transition that never happened.
    expect(insertedDedupKeys()).not.toContain("node:node-1:node_degraded");
  });

  it("does not transition when FEATURE_AUTO_NODE_HEALTH is not set, but still records the streak", async () => {
    mockNode({ consecutive_probe_failures: 2 });
    await onRequestPost({ env: { ...env }, request: makeRequest({ probe_ok: false }) });
    expect(nodesUpdate.mock.calls[0][0].consecutive_probe_failures).toBe(3);
    expect(lifecycleWrites()).toEqual([]);
  });

  it.each(["MAINTENANCE", "DRAINING", "WARMING_UP"])(
    "never recovers a %s node to READY on a long success streak (C1)",
    async (lifecycleState) => {
      mockNode({ lifecycle_state: lifecycleState, consecutive_probe_successes: 10 });
      await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
      expect(nodesUpdate.mock.calls[0][0].consecutive_probe_successes).toBe(11);
      expect(lifecycleWrites()).toEqual([]);
    }
  );

  it.each(["DEGRADED", "WARMING_UP", "PROVISIONING"])(
    "never moves a %s node on 3+ consecutive failed probes (C2)",
    async (lifecycleState) => {
      mockNode({ lifecycle_state: lifecycleState, consecutive_probe_failures: 5 });
      await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false }) });
      expect(lifecycleWrites()).toEqual([]);
    }
  );

  it("recovers DEGRADED to READY at 5 consecutive successes and resolves node_degraded", async () => {
    mockNode({ lifecycle_state: "DEGRADED", consecutive_probe_successes: 4 });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(lifecycleWrites()).toEqual([casWrite("node-1", "DEGRADED", "READY")]);
    expect(resolvedDedupKeys()).toContain("node:node-1:node_degraded");
    expect(insertedDedupKeys()).not.toContain("node:node-1:node_degraded");
  });

  it("blocks Clash-driven DEGRADED -> READY while protocol probes are failing", async () => {
    mockNode({ lifecycle_state: "DEGRADED", consecutive_probe_successes: 4, protocol_probe_failures: 2 });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(lifecycleWrites()).toEqual([]);
  });

  it("applies a protocol_probe report before evaluating, and stores cert days", async () => {
    applyProtocolReport.mockClear();
    mockNode({});
    const protocol_probe = {
      version: 1,
      round: 1,
      hysteria2_cert_days_remaining: 12,
      results: [{ target_node_id: "peer-1", vantage: "peer", protocol: "reality", ok: true, dims: {}, loss_pct: 0 }],
    };
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true, protocol_probe }) });
    expect(applyProtocolReport).toHaveBeenCalledTimes(1);
    const arg = applyProtocolReport.mock.calls[0][0];
    expect(arg).toMatchObject({ reporterNodeId: "node-1", autoHealth: true });
    expect(arg.report.results[0].targetNodeId).toBe("peer-1");
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({ hysteria2_cert_days: 12 });
  });

  it("does not call the protocol store without a report, and survives a store failure", async () => {
    applyProtocolReport.mockClear();
    mockNode({});
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(applyProtocolReport).not.toHaveBeenCalled();
    applyProtocolReport.mockRejectedValueOnce(new Error("boom"));
    const res = await onRequestPost({ env: autoEnv, request: makeRequest({ protocol_probe: { results: [] } }) });
    expect(res.status).toBe(200);
  });

  it("exits FAILED to READY on a single passing probe and resolves node_failed", async () => {
    mockNode({ lifecycle_state: "FAILED", consecutive_probe_failures: 1, failed_reason: "SILENCE" });
    const before = Date.now();
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(nodesUpdate.mock.calls[0][0]).toMatchObject({
      consecutive_probe_failures: 0,
      consecutive_probe_successes: 1,
    });
    expect(lifecycleWrites()).toEqual([casWrite("node-1", "FAILED", "READY")]);
    expect(resolvedDedupKeys()).toContain("node:node-1:node_failed");
    // Check that lifecycle_state_changed_at is set in the lifecycle transition update
    const lifecycleUpdate = nodesUpdate.mock.calls.find(
      ([patch]) => "lifecycle_state" in patch && patch.lifecycle_state === "READY"
    )?.[0];
    expect(lifecycleUpdate).toBeDefined();
    expect(new Date(lifecycleUpdate.lifecycle_state_changed_at).getTime()).toBeGreaterThan(before - 1);
  });

  it("recovers a FAILED node with no probe capability on any authenticated heartbeat (null-probe ruling)", async () => {
    mockNode({ lifecycle_state: "FAILED", failed_reason: "SILENCE" });
    await onRequestPost({ env: autoEnv, request: makeRequest({}) });
    expect(lifecycleWrites()).toEqual([casWrite("node-1", "FAILED", "READY")]);
    expect(resolvedDedupKeys()).toContain("node:node-1:node_failed");
  });

  it("keeps node_failed open for a FAILED node whose probe still fails", async () => {
    mockNode({ lifecycle_state: "FAILED" });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false }) });
    expect(lifecycleWrites()).toEqual([]);
    expect(insertedDedupKeys()).toContain("node:node-1:node_failed");
    expect(resolvedDedupKeys()).not.toContain("node:node-1:node_failed");
  });

  // failed_reason precondition (Phase 12a/12b specs): a canary-abort or
  // boot-timeout FAILED must never be waved back to READY by a passing
  // probe the way a silence-FAILED is -- it needs an admin or a real
  // replacement, not a fluke of one good heartbeat.
  it.each(["CANARY_ABORT", "BOOT_TIMEOUT", "ADMIN"])(
    "does not recover a FAILED node on a passing probe when failed_reason is %s",
    async (failedReason) => {
      mockNode({ lifecycle_state: "FAILED", failed_reason: failedReason });
      await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
      expect(lifecycleWrites()).toEqual([]);
      expect(resolvedDedupKeys()).not.toContain("node:node-1:node_failed");
    }
  );

  it("raises a node_degraded alert on automated transition to DEGRADED", async () => {
    mockNode({ consecutive_probe_failures: 2 });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: false }) });
    expect(alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ alert_type: "node_degraded", dedup_key: "node:node-1:node_degraded" })
    );
  });

  // I1: the alert follows the node's state, not the one request that
  // performed the transition.
  it.each([false, true])(
    "keeps node_degraded open on a later heartbeat while the node is still DEGRADED (probe_ok=%s)",
    async (probeOk) => {
      mockNode({ lifecycle_state: "DEGRADED", consecutive_probe_failures: 3 });
      await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: probeOk }) });
      expect(lifecycleWrites()).toEqual([]);
      expect(insertedDedupKeys()).toContain("node:node-1:node_degraded");
      expect(resolvedDedupKeys()).not.toContain("node:node-1:node_degraded");
    }
  );

  it("resolves node_degraded and node_failed for a READY node", async () => {
    mockNode({});
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(resolvedDedupKeys()).toEqual(
      expect.arrayContaining(["node:node-1:node_degraded", "node:node-1:node_failed"])
    );
    expect(insertedDedupKeys()).toEqual([]);
  });

  it("resolves rather than raises health alerts when FEATURE_AUTO_NODE_HEALTH is off", async () => {
    mockNode({ lifecycle_state: "DEGRADED" });
    await onRequestPost({ env, request: makeRequest({ probe_ok: false }) });
    expect(insertedDedupKeys()).not.toContain("node:node-1:node_degraded");
    expect(resolvedDedupKeys()).toContain("node:node-1:node_degraded");
  });

  it("transitions a different, silent node to FAILED (compare-and-set) and raises node_failed for it", async () => {
    // node-1 (the heartbeating node) is healthy; node-2 is silent.
    mockNode({});
    nodesListSelect.mockResolvedValue({
      data: [{ node_id: "node-2", lifecycle_state: "READY", last_seen_at: stale() }],
      error: null,
    });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(lifecycleWrites()).toEqual([casWrite("node-2", "READY", "FAILED", "SILENCE")]);
    expect(alertsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        alert_type: "node_failed",
        severity: "critical",
        dedup_key: "node:node-2:node_failed",
        node_id: "node-2",
      })
    );
  });

  it("raises no node_failed alert when the silence compare-and-set loses the race", async () => {
    mockNode({});
    casMatches = false;
    nodesListSelect.mockResolvedValue({
      data: [{ node_id: "node-2", lifecycle_state: "READY", last_seen_at: stale() }],
      error: null,
    });
    await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
    expect(insertedDedupKeys()).not.toContain("node:node-2:node_failed");
  });

  it.each(["PROVISIONING", "WARMING_UP", "MAINTENANCE", "DRAINING"])(
    "never silence-fails a stale %s node, even if the candidate query returned it",
    async (lifecycleState) => {
      mockNode({});
      nodesListSelect.mockResolvedValue({
        data: [{ node_id: "node-2", lifecycle_state: lifecycleState, last_seen_at: stale() }],
        error: null,
      });
      await onRequestPost({ env: autoEnv, request: makeRequest({ probe_ok: true }) });
      expect(lifecycleWrites()).toEqual([]);
    }
  );
});

describe("POST /api/agent/heartbeat enrollment token cleanup", () => {
  it("clears a leftover enrollment token, but never while the node is PROVISIONING", async () => {
    await onRequestPost({ env, request: makeRequest({}) });
    const clearCall = nodesUpdate.mock.calls.findIndex(
      ([patch]) => "enrollment_token_hash" in patch
    );
    expect(clearCall).toBeGreaterThan(0);
    expect(nodesUpdate.mock.calls[clearCall][0]).toEqual({
      enrollment_token_hash: null,
      enrollment_token_expires_at: null,
    });
    // A fresh re-enrollment token (lifecycle.js -> PROVISIONING) must
    // survive an old agent's heartbeat.
    expect(updateChains[clearCall].filters).toContainEqual(["neq", "lifecycle_state", "PROVISIONING"]);
  });

  it("never clears the token as part of the telemetry update itself", async () => {
    await onRequestPost({ env, request: makeRequest({}) });
    expect(nodesUpdate.mock.calls[0][0]).not.toHaveProperty("enrollment_token_hash");
  });
});
