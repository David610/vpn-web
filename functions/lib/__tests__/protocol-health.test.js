import { describe, it, expect, vi } from "vitest";
import {
  sanitizeProtocolReport,
  probeResultRows,
  targetVerdict,
  evaluateProtocolHealth,
  protocolAllowsRecovery,
  choosePeers,
  validProbeUri,
  PEER_FRESH_MS,
} from "../protocol-health.js";
import { applyProtocolReport } from "../protocol-health-store.js";

const res = (over = {}) => ({
  target_node_id: "fi-hel-1",
  vantage: "peer",
  protocol: "reality",
  ok: true,
  dims: { tcp_connect: true, handshake: true, https_ipv4: true, dns: true, ipv6: "egress", egress_ipv4: "62.238.46.190", egress_ipv6: "2a01:4f9::1", egress_ip_match: true },
  latency_ms: 41,
  loss_pct: 0,
  failure_streak: 0,
  error: null,
  ...over,
});

describe("sanitizeProtocolReport", () => {
  it("keeps valid results and drops malformed ones", () => {
    const r = sanitizeProtocolReport({
      hysteria2_cert_days_remaining: 42,
      results: [res(), res({ vantage: "evil" }), res({ protocol: "ss" }), res({ ok: "yes" }), res({ target_node_id: "../x" }), null],
    });
    expect(r.certDays).toBe(42);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ targetNodeId: "fi-hel-1", ok: true, latencyMs: 41 });
  });
  it("normalizes unknown dimension values and error classes", () => {
    const r = sanitizeProtocolReport({ results: [res({ dims: { ipv6: "weird", egress_ipv4: "<script>" }, error: "free text secret" })] });
    expect(r.results[0].dims.ipv6).toBe("unknown");
    expect(r.results[0].dims.egress_ipv4).toBeNull();
    expect(r.results[0].error).toBeNull();
  });
  it("returns null for absent or non-array reports", () => {
    expect(sanitizeProtocolReport(undefined)).toBeNull();
    expect(sanitizeProtocolReport({ results: "x" })).toBeNull();
  });
  it("drops hysteria2 verdicts from an agent running tls_insecure_for_tests", () => {
    const out = sanitizeProtocolReport({ tls_insecure_for_tests: true, results: [res(), res({ protocol: "hysteria2" })] });
    expect(out.tlsInsecure).toBe(true);
    expect(out.results.map((r) => r.protocol)).toEqual(["reality"]);
  });
  it("caps the number of results", () => {
    const r = sanitizeProtocolReport({ results: Array.from({ length: 100 }, () => res()) });
    expect(r.results.length).toBe(32);
  });
});

describe("probeResultRows", () => {
  it("emits one row per dimension", () => {
    const report = sanitizeProtocolReport({ results: [res(), res({ protocol: "hysteria2", dims: { handshake: false, https_ipv4: false, dns: false, ipv6: "unknown" }, ok: false, error: "handshake_failed", latency_ms: null, loss_pct: 100 })] });
    const rows = probeResultRows("de-ber-1", report, "t");
    const dims = rows.filter((r) => r.protocol === "reality").map((r) => r.dimension);
    expect(dims).toEqual(["useful_egress", "tcp_connect", "handshake", "https_ipv4", "dns", "ipv6", "egress_ip", "latency", "loss"]);
    const hy = rows.filter((r) => r.protocol === "hysteria2");
    expect(hy.find((r) => r.dimension === "tcp_connect")).toBeUndefined();
    expect(hy.find((r) => r.dimension === "useful_egress")).toMatchObject({ ok: false, value_text: "handshake_failed" });
    expect(hy.find((r) => r.dimension === "ipv6").ok).toBeNull();
  });
});

describe("targetVerdict", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const S = (o) => sanitizeProtocolReport({ results: o }).results;
  it("fails the verdict when any protocol fails (UDP blocked: hysteria2 down, reality up)", () => {
    const v = targetVerdict(S([res(), res({ protocol: "hysteria2", ok: false })]), { lastPeerProbeAt: null, nowMs: now });
    expect(v).toMatchObject({ ok: false, vantage: "peer", protocols: { reality: true, hysteria2: false } });
  });
  it("peer results override self results in the same report", () => {
    const v = targetVerdict(S([res({ vantage: "self" }), res({ ok: false })]), { lastPeerProbeAt: null, nowMs: now });
    expect(v.ok).toBe(false);
    expect(v.vantage).toBe("peer");
  });
  it("ignores self results while a fresh peer view exists", () => {
    const fresh = new Date(now - PEER_FRESH_MS + 1000).toISOString();
    expect(targetVerdict(S([res({ vantage: "self" })]), { lastPeerProbeAt: fresh, nowMs: now })).toBeNull();
  });
  it("falls back to self results when the peer view is stale", () => {
    const stale = new Date(now - PEER_FRESH_MS - 1000).toISOString();
    expect(targetVerdict(S([res({ vantage: "self" })]), { lastPeerProbeAt: stale, nowMs: now })).toMatchObject({ ok: true, vantage: "self" });
  });
});

describe("evaluateProtocolHealth", () => {
  const base = { currentFailures: 0, currentSuccesses: 0, lifecycleState: "READY", failedReason: null, clashFailures: 0 };
  it("degrades READY after 3 consecutive failures (hysteresis)", () => {
    expect(evaluateProtocolHealth({ ...base, ok: false, currentFailures: 1 }).nextState).toBeNull();
    expect(evaluateProtocolHealth({ ...base, ok: false, currentFailures: 2 }).nextState).toBe("DEGRADED");
  });
  it("recovers DEGRADED after 5 consecutive passes only while the clash probe is healthy", () => {
    const d = { ...base, lifecycleState: "DEGRADED", ok: true, currentSuccesses: 4 };
    expect(evaluateProtocolHealth(d).nextState).toBe("READY");
    expect(evaluateProtocolHealth({ ...d, currentSuccesses: 3 }).nextState).toBeNull();
    expect(evaluateProtocolHealth({ ...d, clashFailures: 1 }).nextState).toBeNull();
  });
  it("never moves a node out of FAILED, whatever the reason", () => {
    for (const failedReason of ["SILENCE", "CANARY_ABORT", "BOOT_TIMEOUT", "ADMIN"]) {
      const r = evaluateProtocolHealth({ ...base, lifecycleState: "FAILED", failedReason, ok: true, currentSuccesses: 10 });
      expect(r.nextState).toBeNull();
    }
  });
  it("never moves a node into FAILED", () => {
    const r = evaluateProtocolHealth({ ...base, lifecycleState: "DEGRADED", ok: false, currentFailures: 99 });
    expect(r.nextState).toBeNull();
  });
  it("does not act on admin-owned states", () => {
    for (const s of ["MAINTENANCE", "QUARANTINED", "DRAINING", "WARMING_UP"]) {
      expect(evaluateProtocolHealth({ ...base, lifecycleState: s, ok: false, currentFailures: 5 }).nextState).toBeNull();
    }
  });
  it("protocolAllowsRecovery gates on the protocol failure streak", () => {
    expect(protocolAllowsRecovery({ protocol_probe_failures: 0 })).toBe(true);
    expect(protocolAllowsRecovery({ protocol_probe_failures: 2 })).toBe(false);
    expect(protocolAllowsRecovery({})).toBe(true);
  });
});

describe("choosePeers / validProbeUri", () => {
  it("chooses a bounded deterministic subset", () => {
    const peers = Array.from({ length: 10 }, (_, i) => ({ node_id: `n${i}` }));
    const a = choosePeers("me", peers, 0);
    expect(a).toHaveLength(3);
    expect(choosePeers("me", peers, 0)).toEqual(a);
  });
  it("validates probe URI schemes", () => {
    expect(validProbeUri("vless://u@h:1?x", "vless")).toBe(true);
    expect(validProbeUri("hysteria2://p@h:1", "vless")).toBe(false);
    expect(validProbeUri("vless://u@h:1 x", "vless")).toBe(false);
    expect(validProbeUri("vless://" + "a".repeat(3000), "vless")).toBe(false);
  });
});

function fakeSupabase(nodes, { fleet, history = [] } = {}) {
  const calls = { inserts: [], updates: [], rpcs: [], cas: [] };
  const fleetRows = fleet ?? [{ node_id: "de-ber-1", lifecycle_state: "READY" }, ...Object.values(nodes).map((n) => ({ node_id: n.node_id, lifecycle_state: n.lifecycle_state }))];
  const supabase = {
    from(table) {
      if (table === "node_probe_results") {
        const hq = { select: () => hq, eq: () => hq, neq: () => hq, gte: () => hq, order: () => hq, limit: async () => ({ data: history, error: null }) };
        return { ...hq, insert: async (rows) => (calls.inserts.push(rows), { error: null }) };
      }
      if (table !== "nodes") throw new Error(table);
      return {
        select: () => {
          const q = {
            eq: (_c, id) => ((q.id = id), q),
            in: () => q,
            is: async () => ({ data: fleetRows, error: null }),
            maybeSingle: async () => ({ data: nodes[q.id] ?? null, error: null }),
          };
          return q;
        },
        update: (patch) => {
          const f = [];
          const chain = {
            eq: (c, v) => (f.push([c, v]), chain),
            select: () => chain,
            maybeSingle: async () => (calls.cas.push({ patch, f }), { data: { node_id: "x" }, error: null }),
            then: (r) => (calls.updates.push({ patch, f }), r({ error: null })),
          };
          return chain;
        },
      };
    },
    rpc: vi.fn(async (name, args) => (calls.rpcs.push([name, args]), { error: null })),
  };
  return { supabase, calls };
}

describe("applyProtocolReport", () => {
  const node = (o) => ({ node_id: "fi-hel-1", lifecycle_state: "READY", failed_reason: null, consecutive_probe_failures: 0, protocol_probe_failures: 0, protocol_probe_successes: 0, last_peer_probe_at: null, protocol_health: null, ...o });

  it("stores rows, updates counters/summary, prunes, and degrades after the threshold", async () => {
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) });
    const report = sanitizeProtocolReport({ results: [res(), res({ protocol: "hysteria2", ok: false, error: "handshake_failed" })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(calls.inserts[0].length).toBeGreaterThan(10);
    const u = calls.updates[0].patch;
    expect(u.protocol_probe_failures).toBe(3);
    expect(u.last_peer_probe_at).toBeTruthy();
    expect(u.protocol_health.hysteria2.ok).toBe(false);
    expect(u.protocol_health.reality.ok).toBe(true);
    expect(calls.rpcs[0][0]).toBe("prune_node_probe_results");
    expect(out.transitions).toEqual([{ targetId: "fi-hel-1", from: "READY", to: "DEGRADED" }]);
    expect(calls.cas[0].f).toContainEqual(["lifecycle_state", "READY"]);
  });

  it("does not write lifecycle when FEATURE_AUTO_NODE_HEALTH is off", async () => {
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) });
    const report = sanitizeProtocolReport({ results: [res({ ok: false })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: false });
    expect(out.transitions).toEqual([]);
    expect(calls.cas).toHaveLength(0);
    expect(calls.updates[0].patch.protocol_probe_failures).toBe(3);
  });

  it("ignores a self-vantage claim about another node", async () => {
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) });
    const report = sanitizeProtocolReport({ results: [res({ vantage: "self", ok: false })] });
    await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(calls.updates).toHaveLength(0);
    expect(calls.cas).toHaveLength(0);
  });

  it("never recovers a CANARY_ABORT FAILED node from passing peer probes", async () => {
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ lifecycle_state: "FAILED", failed_reason: "CANARY_ABORT", protocol_probe_successes: 20 }) });
    const report = sanitizeProtocolReport({ results: [res()] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(out.transitions).toEqual([]);
    expect(calls.cas).toHaveLength(0);
  });

  it("ignores reports from a reporter that is not an active probing node", async () => {
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) }, { fleet: [{ node_id: "fi-hel-1", lifecycle_state: "READY" }] });
    const report = sanitizeProtocolReport({ results: [res({ ok: false })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(out).toEqual({ rows: 0, transitions: [] });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("drops peer results about targets the reporter was not assigned", async () => {
    const nodes = {};
    const fleet = [{ node_id: "de-ber-1", lifecycle_state: "READY" }];
    for (let i = 0; i < 12; i++) fleet.push({ node_id: `n-${i}`, lifecycle_state: "READY" });
    const now = Date.UTC(2026, 8, 26, 12, 30);
    const chosen = new Set([...choosePeers("de-ber-1", fleet.slice(1), now), ...choosePeers("de-ber-1", fleet.slice(1), now - 3_600_000)].map((p) => p.node_id));
    const victim = fleet.slice(1).find((n) => !chosen.has(n.node_id)).node_id;
    nodes[victim] = node({ node_id: victim, protocol_probe_failures: 2 });
    const { supabase, calls } = fakeSupabase(nodes, { fleet });
    const report = sanitizeProtocolReport({ results: [res({ target_node_id: victim, ok: false })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true, nowMs: now });
    expect(out.transitions).toEqual([]);
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("a single peer's failure does not count while another peer sees the target passing", async () => {
    const history = [{ reporter_node_id: "us-nyc-1", ok: true, observed_at: new Date().toISOString() }];
    const { supabase, calls } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) }, { history });
    const report = sanitizeProtocolReport({ results: [res({ ok: false })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(out.transitions).toEqual([]);
    expect(calls.updates[0].patch.protocol_probe_failures).toBeUndefined();
    expect(calls.inserts).toHaveLength(1);
  });

  it("peer failures count when every other fresh peer also fails", async () => {
    const history = [{ reporter_node_id: "us-nyc-1", ok: false, observed_at: new Date().toISOString() }];
    const { supabase } = fakeSupabase({ "fi-hel-1": node({ protocol_probe_failures: 2 }) }, { history });
    const report = sanitizeProtocolReport({ results: [res({ ok: false })] });
    const out = await applyProtocolReport({ supabase, reporterNodeId: "de-ber-1", report, autoHealth: true });
    expect(out.transitions).toEqual([{ targetId: "fi-hel-1", from: "READY", to: "DEGRADED" }]);
  });
});
