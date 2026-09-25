import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import {
  advanceOperation,
  CREATE_NODE_STEPS,
  READINESS_CONSECUTIVE_PASSES,
} from "../fleet-operations.js";

const NODE_ID = "de-fsn-001";
const HOSTNAME = "de-fsn-001.nodes.example.test";
const env = {
  SITE_URL: "https://arcana.example.test",
  FLEET_SINGBOX_VPN_VERSION: "v1.1.0-rc.2",
};

function seed({ deadlineAt } = {}) {
  return {
    nodes: [
      {
        node_id: NODE_ID,
        role: "EXIT",
        lifecycle_state: "PROVISIONING",
        hostname: HOSTNAME,
        provider: "hetzner",
        provider_instance_id: null,
        ip_address: null,
        dns_record_id: null,
        last_seen_at: null,
        bootstrap_stage: null,
        bootstrap_status: null,
        bootstrap_message: null,
      },
    ],
    fleet_operations: [
      {
        id: "op-1",
        type: "CREATE_NODE",
        status: "RUNNING",
        node_id: NODE_ID,
        attempts: 0,
        detail: { provider: "hetzner", region: "fsn1" },
        deadline_at: deadlineAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    operation_steps: CREATE_NODE_STEPS.map((name, i) => ({
      id: i + 1,
      operation_id: "op-1",
      step_index: i,
      name,
      status: "PENDING",
      attempts: 0,
      detail: {},
    })),
  };
}

let db;
let provider;
let dnsAdapter;
let probe;
let ctx;

async function rows(table) {
  const { data } = await db.from(table).select("*");
  return data;
}
async function node() {
  return (await rows("nodes"))[0];
}
async function op() {
  return (await rows("fleet_operations"))[0];
}
async function step(name) {
  return (await rows("operation_steps")).find((s) => s.name === name);
}
async function advance() {
  return advanceOperation(ctx, await op());
}
async function setNode(patch) {
  await db.from("nodes").update(patch).eq("node_id", NODE_ID);
}

beforeEach(() => {
  db = makeFakeSupabase(seed());
  provider = {
    findInstanceByNodeId: vi.fn().mockResolvedValue(null),
    createInstance: vi.fn().mockResolvedValue({
      providerInstanceId: "12345",
      ipAddress: "203.0.113.9",
      region: "fsn1",
    }),
  };
  dnsAdapter = { upsertAddressRecord: vi.fn().mockResolvedValue({ recordId: "rec-1" }) };
  probe = vi.fn().mockResolvedValue({ ok: true, checks: { subscription_tls: { ok: true }, reality_tcp: { ok: true } } });
  ctx = {
    supabase: db,
    env,
    providers: vi.fn(() => provider),
    dns: vi.fn(() => dnsAdapter),
    probe,
  };
});

describe("CREATE_NODE operation", () => {
  it("drives a node from PROVISIONING to READY across ticks, gated on real signals at each step", async () => {
    // Tick 1: server created, DNS published, then waits for enrollment.
    let result = await advance();
    expect(result).toMatchObject({ status: "RUNNING", step: "AWAIT_ENROLLMENT", waitSeconds: 30 });
    expect(provider.createInstance).toHaveBeenCalledTimes(1);
    const createArgs = provider.createInstance.mock.calls[0][0];
    expect(createArgs).toMatchObject({ nodeId: NODE_ID, region: "fsn1" });
    expect(createArgs.userData).toContain(`PUBLIC_HOST=${HOSTNAME}`);
    expect(createArgs.userData).toContain("SINGBOX_VPN_VERSION=v1.1.0-rc.2");

    // The token baked into user_data matches the stored hash -- and only
    // the hash is stored.
    const token = createArgs.userData.match(/ENROLLMENT_TOKEN=([0-9a-f]{64})/)[1];
    const n1 = await node();
    expect(n1.enrollment_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(n1.enrollment_token_hash).not.toBe(token);
    expect(n1).toMatchObject({ provider_instance_id: "12345", ip_address: "203.0.113.9", dns_record_id: "rec-1" });
    expect(dnsAdapter.upsertAddressRecord).toHaveBeenCalledWith({ name: HOSTNAME, type: "A", content: "203.0.113.9" });

    // Still PROVISIONING: keeps waiting, no side effects repeated.
    result = await advance();
    expect(result.step).toBe("AWAIT_ENROLLMENT");
    expect(provider.createInstance).toHaveBeenCalledTimes(1);

    // Node enrolls (agent/enroll.js) -> waits for its bootstrap to finish.
    await setNode({ lifecycle_state: "WARMING_UP" });
    result = await advance();
    expect(result.step).toBe("AWAIT_BOOTSTRAP");

    // Bootstrap reports COMPLETE and the agent heartbeats.
    await setNode({ bootstrap_stage: "COMPLETE", bootstrap_status: "OK", last_seen_at: new Date().toISOString() });
    for (let i = 1; i < READINESS_CONSECUTIVE_PASSES; i++) {
      result = await advance();
      expect(result).toMatchObject({ step: "VERIFY_READINESS", status: "RUNNING" });
      expect((await step("VERIFY_READINESS")).detail.consecutivePasses).toBe(i);
      expect((await node()).lifecycle_state).toBe("WARMING_UP");
    }
    result = await advance();
    expect(result).toEqual({ status: "COMPLETED" });
    expect((await node()).lifecycle_state).toBe("READY");
    expect((await op()).status).toBe("COMPLETED");
    expect((await rows("operation_steps")).every((s) => s.status === "COMPLETED")).toBe(true);

    // No credential ever lands in operation/step records.
    const persisted = JSON.stringify([await rows("fleet_operations"), await rows("operation_steps")]);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(n1.enrollment_token_hash);
  });

  it("adopts a server whose create response was lost instead of creating a second one or minting a new token", async () => {
    provider.findInstanceByNodeId.mockResolvedValue({ providerInstanceId: "999", ipAddress: "198.51.100.7" });
    await setNode({ enrollment_token_hash: "h".repeat(64) });
    await advance();
    expect(provider.createInstance).not.toHaveBeenCalled();
    const n = await node();
    expect(n).toMatchObject({ provider_instance_id: "999", ip_address: "198.51.100.7" });
    expect(n.enrollment_token_hash).toBe("h".repeat(64));
    expect((await step("CREATE_INSTANCE")).detail).toMatchObject({ adopted: true });
  });

  it("backs off and retries a transient provider failure without failing the operation", async () => {
    provider.createInstance.mockRejectedValueOnce(new Error("Hetzner API returned 503"));
    const result = await advance();
    expect(result).toMatchObject({ status: "RUNNING", step: "CREATE_INSTANCE", waitSeconds: 15 });
    const o = await op();
    expect(o.status).toBe("RUNNING");
    expect(new Date(o.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(o.last_error).toMatch(/503/);
    expect(await step("CREATE_INSTANCE")).toMatchObject({ status: "RUNNING", attempts: 1 });

    const retry = await advance();
    expect(retry.step).toBe("AWAIT_ENROLLMENT");
    expect(provider.createInstance).toHaveBeenCalledTimes(2);
  });

  it("stops (FAILED) when an admin quarantines the node mid-bootstrap, without un-quarantining it", async () => {
    await advance();
    await setNode({ lifecycle_state: "QUARANTINED" });
    const result = await advance();
    expect(result).toMatchObject({ status: "FAILED", step: "AWAIT_ENROLLMENT" });
    expect((await op()).status).toBe("FAILED");
    expect((await node()).lifecycle_state).toBe("QUARANTINED");
  });

  it("fails the operation and the node once the deadline passes", async () => {
    db = makeFakeSupabase(seed({ deadlineAt: new Date(Date.now() - 1000).toISOString() }));
    ctx.supabase = db;
    const result = await advance();
    expect(result).toMatchObject({ status: "FAILED", step: "CREATE_INSTANCE" });
    expect((await op()).last_error).toMatch(/deadline exceeded/);
    expect((await node()).lifecycle_state).toBe("FAILED");
    expect(provider.createInstance).not.toHaveBeenCalled();
  });

  it("requires consecutive readiness passes: one failed probe resets the streak", async () => {
    await advance();
    await setNode({
      lifecycle_state: "WARMING_UP",
      bootstrap_stage: "COMPLETE",
      bootstrap_status: "OK",
      last_seen_at: new Date().toISOString(),
    });
    await advance(); // 1 pass
    probe.mockResolvedValueOnce({ ok: false, checks: { reality_tcp: { ok: false, error: "refused" } } });
    await advance(); // reset
    expect((await step("VERIFY_READINESS")).detail.consecutivePasses).toBe(0);
    await advance(); // 1 pass
    expect((await node()).lifecycle_state).toBe("WARMING_UP");
  });

  it("never marks a node READY on probes alone when its heartbeat is stale", async () => {
    await advance();
    await setNode({
      lifecycle_state: "WARMING_UP",
      bootstrap_stage: "COMPLETE",
      bootstrap_status: "OK",
      last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    for (let i = 0; i < READINESS_CONSECUTIVE_PASSES + 2; i++) await advance();
    expect((await node()).lifecycle_state).toBe("WARMING_UP");
    expect((await step("VERIFY_READINESS")).detail).toMatchObject({ consecutivePasses: 0, heartbeatFresh: false });
  });

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
});
