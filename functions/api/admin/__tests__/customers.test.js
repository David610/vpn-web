import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const rpc = vi.fn();
let statsResults;

/** A chainable, awaitable stand-in for a PostgREST query that resolves to a canned result. */
function chain(result) {
  const builder = {};
  for (const m of ["select", "in", "eq", "is"]) builder[m] = vi.fn(() => builder);
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc,
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: adminMaybeSingle,
        };
      }
      if (table in statsResults) return chain(statsResults[table]);
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

function row(overrides = {}) {
  return {
    user_id: "user-1",
    account_id: "acct-1",
    account_role: "owner",
    member_count: 1,
    email: "alice@example.com",
    subscription_status: "active",
    current_period_end: "2026-10-21T00:00:00Z",
    vpn_account_id: 1,
    vpn_user_id: "vpn-abc",
    node_id: "node-1",
    enabled: true,
    total_count: 1,
    ...overrides,
  };
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({
    data: { claims: { sub: "admin-1", aal: "aal2" } },
    error: null,
  });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  rpc.mockReset().mockResolvedValue({ data: [row()], error: null });
  statsResults = {
    vpn_links: { data: [{ account_id: "acct-1" }, { account_id: "acct-1" }], error: null },
    external_vpn_devices: { data: [{ account_id: "acct-1" }], error: null },
    subscriptions: { data: [{ account_id: "acct-1", extra_seats: 3 }], error: null },
  };
});

describe("GET /api/admin/customers", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the paginated DB directory response", async () => {
    const res = await onRequestGet({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.customers).toEqual([
      {
        userId: "user-1",
        accountId: "acct-1",
        accountRole: "owner",
        memberCount: 1,
        email: "alice@example.com",
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-10-21T00:00:00Z",
        vpnAccountId: 1,
        vpnUserId: "vpn-abc",
        nodeId: "node-1",
        enabled: true,
        linkCount: 2,
        clientCount: 1,
        capacity: 6,
      },
    ]);
    expect(body).toMatchObject({ page: 1, perPage: 50, total: 1, totalPages: 1 });
  });

  it("passes search and pagination to Postgres rather than filtering in memory", async () => {
    rpc.mockResolvedValue({
      data: [row({ total_count: 121 })],
      error: null,
    });
    const res = await onRequestGet({
      env,
      request: makeRequest("?q=alice&page=3&per_page=40"),
    });
    const body = await res.json();

    expect(rpc).toHaveBeenCalledWith("admin_customer_directory", {
      p_query: "alice",
      p_limit: 40,
      p_offset: 80,
    });
    expect(body).toMatchObject({ page: 3, perPage: 40, total: 121, totalPages: 4 });
  });

  it("caps page size at 100", async () => {
    await onRequestGet({ env, request: makeRequest("?per_page=999") });
    expect(rpc).toHaveBeenCalledWith(
      "admin_customer_directory",
      expect.objectContaining({ p_limit: 100 })
    );
  });

  it("returns an empty page without inventing a count", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const body = await (await onRequestGet({ env, request: makeRequest("?page=2") })).json();
    expect(body.customers).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("still returns the directory, without link counts, when the counts cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    statsResults.vpn_links = { data: null, error: { message: "boom" } };
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers[0]).toMatchObject({ email: "alice@example.com", linkCount: null, clientCount: null, capacity: null });
  });

  it("exposes counts only, never a link, token or URL", async () => {
    statsResults.vpn_links = { data: [{ account_id: "acct-1", name: "Secret", token: "t0ken" }], error: null };
    const text = await (await onRequestGet({ env, request: makeRequest() })).text();
    expect(text).not.toMatch(/t0ken|Secret|subscription_token|configuration/i);
  });
});
