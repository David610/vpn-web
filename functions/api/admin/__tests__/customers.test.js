import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const adminMaybeSingle = vi.fn();
const listUsers = vi.fn();
let subsResult = { data: [], error: null };
let vpnResult = { data: [], error: null };

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { listUsers } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "subscriptions") {
        return { select: vi.fn(() => ({ order: vi.fn(() => Promise.resolve(subsResult)) })) };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn(() => Promise.resolve(vpnResult)) };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../customers.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest(query = "") {
  return new Request(`https://example.test/api/admin/customers${query}`, {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  listUsers.mockReset().mockResolvedValue({
    data: { users: [{ id: "user-1", email: "alice@example.com" }] },
    error: null,
  });
  subsResult = {
    data: [{ user_id: "user-1", status: "active", current_period_end: "2026-10-21T00:00:00Z" }],
    error: null,
  };
  vpnResult = {
    data: [{ id: 1, user_id: "user-1", vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }],
    error: null,
  };
});

describe("GET /api/admin/customers", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("merges subscriptions, vpn_accounts, and auth emails into one row per customer", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.customers).toEqual([
      {
        userId: "user-1",
        email: "alice@example.com",
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-10-21T00:00:00Z",
        vpnAccountId: 1,
        vpnUserId: "vpn-abc",
        nodeId: "node-1",
        enabled: true,
      },
    ]);
  });

  it("filters by the q query param against email/vpn_user_id", async () => {
    const res = await onRequestGet({ env, request: makeRequest("?q=bob") });
    const body = await res.json();
    expect(body.customers).toEqual([]);
  });

  it("deduplicates resubscribers — a user with two subscription rows appears once", async () => {
    subsResult = {
      data: [
        { user_id: "user-1", status: "active", current_period_end: "2026-10-21T00:00:00Z" },
        { user_id: "user-1", status: "canceled", current_period_end: "2025-10-21T00:00:00Z" },
      ],
      error: null,
    };
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0].subscriptionStatus).toBe("active");
  });
});
