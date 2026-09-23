import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
let nodesSelect;
let samplesResult;
let dailyResult;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      if (table === "nodes") return { select: nodesSelect };
      if (table === "node_traffic_samples") {
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn(() => Promise.resolve(samplesResult)),
        };
      }
      if (table === "node_traffic_daily") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => Promise.resolve(dailyResult)),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../nodes.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/nodes", { headers: { Authorization: "Bearer good" } });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  samplesResult = { data: [], error: null };
  dailyResult = { data: [], error: null };
});

/** A traffic sample `agoMs` in the past covering `interval` seconds. */
function sample({ agoMs = 5_000, deltaUp = 0, deltaDown = 0, interval = 15, connections = 0 } = {}) {
  return {
    node_id: "node-1",
    delta_up: deltaUp,
    delta_down: deltaDown,
    interval_seconds: interval,
    connections_open: connections,
    sampled_at: new Date(Date.now() - agoMs).toISOString(),
  };
}

describe("GET /api/admin/nodes", () => {
  it("classifies a node seen 10s ago as online", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("online");
  });

  it("classifies a node seen 90s ago as degraded", async () => {
    const stale = new Date(Date.now() - 90_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: stale, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("degraded");
  });

  it("classifies a node seen 200s ago as offline", async () => {
    const old = new Date(Date.now() - 200_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: old, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });

  it("classifies a node with no last_seen_at as offline", async () => {
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: null, revoked_at: null }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("offline");
  });

  it("classifies a revoked node as revoked regardless of last_seen_at", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const revokedDate = new Date(Date.now() - 30_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: revokedDate }], error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(body.nodes[0].status).toBe("revoked");
  });

  it("derives throughput in bits per second from the latest sample", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    // 1,500,000 bytes over 15s = 100,000 B/s = 800,000 bit/s.
    samplesResult = { data: [sample({ deltaDown: 1_500_000, interval: 15, connections: 7 })], error: null };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0].traffic.bpsDown).toBe(800_000);
    expect(body.nodes[0].traffic.connectionsOpen).toBe(7);
  });

  it("reports null throughput for a stale sample rather than zero", async () => {
    // "Unknown" and "idle" are different states for an operator; a stale
    // figure that looks live is worse than no figure.
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    samplesResult = { data: [sample({ agoMs: 300_000, deltaDown: 1_500_000 })], error: null };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0].traffic.bpsDown).toBeNull();
    expect(body.nodes[0].traffic.connectionsOpen).toBeNull();
  });

  it("reports null throughput for a node that has never reported", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    samplesResult = { data: [], error: null };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0].traffic.bpsDown).toBeNull();
    expect(body.nodes[0].traffic.todayBytesDown).toBe(0);
  });

  it("uses only the most recent sample per node", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    // Ordered newest-first by the query, so the first row wins.
    samplesResult = {
      data: [
        sample({ agoMs: 5_000, deltaDown: 150_000, interval: 15 }),
        sample({ agoMs: 20_000, deltaDown: 999_999, interval: 15 }),
      ],
      error: null,
    };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0].traffic.bpsDown).toBe(80_000);
  });

  it("returns heartbeat host-health telemetry without replacing VPN traffic", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({
      data: [{
        node_id: "node-1",
        last_seen_at: recent,
        revoked_at: null,
        telemetry_at: recent,
        agent_version: "1.0.0",
        vpn_version: "1.0.0",
        singbox_version: "1.13.19",
        uptime_seconds: 90061,
        cpu_percent: 12.5,
        memory_percent: 44.5,
        disk_percent: 61.2,
        network_rx_bps: 1000,
        network_tx_bps: 2000,
        configured_users: 7,
        active_users_recent: null,
      }],
      error: null,
    });
    samplesResult = {
      data: [sample({ deltaDown: 1_500_000, interval: 15, connections: 3 })],
      error: null,
    };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0]).toMatchObject({
      cpuPercent: 12.5,
      memoryPercent: 44.5,
      diskPercent: 61.2,
      networkRxBps: 1000,
      networkTxBps: 2000,
      configuredUsers: 7,
      singboxVersion: "1.13.19",
      traffic: {
        bpsDown: 800_000,
        connectionsOpen: 3,
      },
    });
  });

  it("includes today's rollup totals", async () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    nodesSelect = vi.fn().mockResolvedValue({ data: [{ node_id: "node-1", last_seen_at: recent, revoked_at: null }], error: null });
    dailyResult = { data: [{ node_id: "node-1", bytes_up: 111, bytes_down: 222 }], error: null };

    const body = await (await onRequestGet({ env, request: makeRequest() })).json();
    expect(body.nodes[0].traffic.todayBytesUp).toBe(111);
    expect(body.nodes[0].traffic.todayBytesDown).toBe(222);
  });
});
