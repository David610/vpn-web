import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
let tableResults = {};

function queryFor(table) {
  const state = { filters: [] };
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column, value) => {
      state.filters.push(["eq", column, value]);
      return query;
    }),
    in: vi.fn((column, value) => {
      state.filters.push(["in", column, value]);
      return query;
    }),
    is: vi.fn((column, value) => {
      state.filters.push(["is", column, value]);
      return query;
    }),
    gt: vi.fn((column, value) => {
      state.filters.push(["gt", column, value]);
      return query;
    }),
    gte: vi.fn((column, value) => {
      state.filters.push(["gte", column, value]);
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then(onFulfilled, onRejected) {
      const resolver = tableResults[table];
      const result =
        typeof resolver === "function"
          ? resolver(state.filters)
          : resolver ?? { data: [], count: 0, error: null };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return query;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: adminMaybeSingle,
        };
      }
      return queryFor(table);
    }),
  })),
}));

const { onRequestGet } = await import("../overview.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/overview", {
    headers: { Authorization: "Bearer good" },
  });
}

function eqValue(filters, wanted) {
  return filters.find(([op, column]) => op === "eq" && column === wanted)?.[2];
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({
    data: { claims: { sub: "admin-1", aal: "aal2" } },
    error: null,
  });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });

  const now = Date.now();
  tableResults = {
    customer_accounts: { data: null, count: 10, error: null },
    subscriptions: (filters) => {
      const status = eqValue(filters, "status");
      if (status === "active") return { data: null, count: 7, error: null };
      if (status === "trialing") return { data: null, count: 2, error: null };
      if (status === "past_due") return { data: null, count: 1, error: null };
      if (status === "canceled") return { data: null, count: 3, error: null };
      if (filters.some(([op, column]) => op === "in" && column === "status")) {
        return { data: [{ extra_seats: 1 }, { extra_seats: 2 }], count: null, error: null };
      }
      return { data: [], count: 0, error: null };
    },
    account_members: { data: null, count: 18, error: null },
    member_invites: { data: null, count: 2, error: null },
    admin_entitlements: {
      data: [
        { expires_at: new Date(now + 86_400_000).toISOString() },
        { expires_at: new Date(now - 86_400_000).toISOString() },
      ],
      count: null,
      error: null,
    },
    vpn_accounts: (filters) => {
      const enabled = eqValue(filters, "enabled");
      if (enabled === true) return { data: null, count: 13, error: null };
      if (enabled === false) return { data: null, count: 2, error: null };
      return { data: null, count: 15, error: null };
    },
    provisioning_jobs: (filters) => {
      const status = eqValue(filters, "status");
      const counts = { pending: 4, claimed: 1, failed: 2 };
      return { data: null, count: counts[status] ?? 0, error: null };
    },
    nodes: {
      data: [
        { last_seen_at: new Date(now - 30_000).toISOString(), revoked_at: null },
        { last_seen_at: new Date(now - 5 * 60_000).toISOString(), revoked_at: null },
        { last_seen_at: new Date(now - 10_000).toISOString(), revoked_at: new Date(now).toISOString() },
        { last_seen_at: null, revoked_at: null },
      ],
      count: null,
      error: null,
    },
    node_traffic_samples: {
      data: [
        {
          node_id: "node-1",
          delta_down: 15_000_000,
          delta_up: 3_750_000,
          interval_seconds: 15,
          sampled_at: new Date(now - 5_000).toISOString(),
        },
        {
          node_id: "node-2",
          delta_down: 7_500_000,
          delta_up: 1_875_000,
          interval_seconds: 15,
          sampled_at: new Date(now - 5_000).toISOString(),
        },
      ],
      count: null,
      error: null,
    },
    node_traffic_daily: {
      data: [
        { bytes_down: 1000, bytes_up: 200 },
        { bytes_down: 3000, bytes_up: 800 },
      ],
      count: null,
      error: null,
    },
    operational_alerts: { data: null, count: 2, error: null },
    abuse_signals: { data: null, count: 1, error: null },
  };
});

describe("GET /api/admin/overview", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("returns expanded business and operations metrics", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      customers: { total: 10, active: 7, trialing: 2, past_due: 1, canceled: 3 },
      members: {
        active: 18,
        pending_invites: 2,
        admin_grants: 1,
        paid_extra_seats: 3,
      },
      vpn: { accounts: 15, enabled: 13, disabled: 2 },
      jobs: { pending: 4, claimed: 1, failed: 2 },
      nodes: { online: 1, offline: 2 },
      usage: {
        download_bps: 12_000_000,
        upload_bps: 3_000_000,
        month_download_bytes: 4000,
        month_upload_bytes: 1000,
        month_total_bytes: 5000,
      },
      alerts: { open: 2 },
      abuse: { open: 1 },
    });
  });

  it("returns 500 instead of zeroed metrics when any query fails", async () => {
    tableResults.vpn_accounts = {
      data: null,
      count: null,
      error: { message: "connection reset" },
    };
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
  });
});
