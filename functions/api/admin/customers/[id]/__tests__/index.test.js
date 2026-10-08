import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const getUserById = vi.fn();
let linkRows, routeRows, subMaybeSingle, vpnAccountsEq, jobsOrder, jobsLimit, jobsIn, memberMaybeSingle, accountMaybeSingle, memberCount;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims, admin: { getUserById } },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      if (table === "account_members") {
        // Serves both getAccountForUser (select/eq/maybeSingle) and the
        // seat-count query (select with { head: true } then eq, awaited).
        const chain = {
          select: vi.fn((_cols, opts) => {
            chain._isCount = Boolean(opts?.head);
            return chain;
          }),
          eq: vi.fn(() => (chain._isCount ? memberCount() : chain)),
          maybeSingle: () => memberMaybeSingle(),
        };
        return chain;
      }
      if (table === "customer_accounts") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: () => accountMaybeSingle() };
      }
      if (table === "subscriptions") {
        // getLiveSubscription lists every live row (an account may hold
        // several) and picks the longest-running one.
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: () =>
            Promise.resolve(subMaybeSingle()).then((r) => ({
              data: r?.data ? [r.data] : [],
              error: r?.error ?? null,
            })),
        };
      }
      if (table === "vpn_accounts") {
        // getVpnAccountsForUser: select(...).eq("user_id", userId) — a list,
        // no .maybeSingle(), since a user can have 2+ devices.
        return { select: vi.fn().mockReturnThis(), eq: vpnAccountsEq };
      }
      if (table === "provisioning_jobs") {
        const chain = {
          select: vi.fn(() => chain),
          in: vi.fn((...args) => {
            jobsIn(...args);
            return chain;
          }),
          order: vi.fn((...args) => {
            jobsOrder(...args);
            return chain;
          }),
          limit: (...args) => jobsLimit(...args),
        };
        return chain;
      }
      if (table === "admin_entitlements") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === "vpn_links") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: () => Promise.resolve(linkRows()),
        };
      }
      if (table === "logical_routes") {
        return { select: vi.fn().mockReturnThis(), in: () => Promise.resolve(routeRows()) };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

const { onRequestGet } = await import("../index.js");
const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };

function makeRequest() {
  return new Request("https://example.test/api/admin/customers/user-1", {
    headers: { Authorization: "Bearer good" },
  });
}

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
  getUserById.mockReset().mockResolvedValue({ data: { user: { email: "alice@example.com" } }, error: null });
  memberMaybeSingle = vi.fn().mockResolvedValue({ data: { account_id: "acct-1", role: "owner" }, error: null });
  accountMaybeSingle = vi.fn().mockResolvedValue({ data: { stripe_customer_id: "cus_123" }, error: null });
  memberCount = vi.fn().mockResolvedValue({ count: 1, error: null });
  subMaybeSingle = vi.fn().mockResolvedValue({
    data: { status: "active", current_period_end: "2026-10-21T00:00:00Z", stripe_subscription_id: "sub_123" },
    error: null,
  });
  vpnAccountsEq = vi.fn().mockResolvedValue({ data: [{ id: 1, vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }], error: null });
  linkRows = vi.fn().mockReturnValue({
    data: [
      { id: "l1", name: "Personal", status: "active", desired_route_id: "route_de_fast", location_mode: "auto", created_at: "2026-10-06T00:00:00Z", revoked_at: null, subscription_token_hash: "must-not-leak" },
      { id: "l2", name: "Old phone", status: "revoked", desired_route_id: "route_nl_fast", location_mode: "manual", created_at: "2026-09-22T00:00:00Z", revoked_at: "2026-10-01T00:00:00Z" },
    ],
    error: null,
  });
  routeRows = vi.fn().mockReturnValue({
    data: [
      { id: "route_de_fast", display_name: "Germany", privacy_class: "fast" },
      { id: "route_nl_fast", display_name: "Netherlands", privacy_class: "fast" },
    ],
    error: null,
  });
  jobsOrder = vi.fn();
  jobsIn = vi.fn();
  jobsLimit = vi.fn().mockResolvedValue({
    data: [{ id: 9, job_type: "CREATE_USER", status: "done", created_at: "t1", claimed_at: "t2", completed_at: "t3", result: { subscription_url: "https://secret" } }],
    error: null,
  });
});

describe("GET /api/admin/customers/:id", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(401);
  });

  it("redacts subscription_url in job history", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs[0].result.subscription_url).toBe("[redacted]");
  });

  it("limits embedded provisioning history to 100 rows", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    expect(jobsLimit).toHaveBeenCalledWith(100);
  });

  it("returns an empty vpnAccounts list when the user has none", async () => {
    vpnAccountsEq.mockResolvedValue({ data: [], error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.vpnAccounts).toEqual([]);
  });

  it("returns every provisioned device, not just one (the repro this fix targets)", async () => {
    vpnAccountsEq.mockResolvedValue({
      data: [
        { id: 1, vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true },
        { id: 2, vpn_user_id: "vpn-def", node_id: "node-2", enabled: true },
      ],
      error: null,
    });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vpnAccounts).toHaveLength(2);
  });

  it("returns 500 (not a false empty vpnAccounts) when the vpn_accounts query errors", async () => {
    vpnAccountsEq.mockResolvedValue({ data: null, error: { message: "db unavailable" } });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(500);
  });

  it("returns 500 when the subscriptions query errors", async () => {
    subMaybeSingle.mockResolvedValue({ data: null, error: { message: "db unavailable" } });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(500);
  });

  it("reports the account's Stripe customer, not a subscription's", async () => {
    // stripe_customer_id lives on customer_accounts so the billing portal
    // can reach it for an account whose subscription has lapsed.
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.subscription.stripeCustomerId).toBe("cus_123");
    expect(body.accountId).toBe("acct-1");
    expect(body.accountRole).toBe("owner");
  });

  it("returns a null subscription for a user with no account membership", async () => {
    memberMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.subscription).toBeNull();
    expect(body.accountId).toBeNull();
  });

  it("lists the customer's links as metadata only", async () => {
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.links).toEqual([
      { id: "l1", name: "Personal", status: "active", routing: 1, locationMode: "auto", location: "Germany", createdAt: "2026-10-06T00:00:00Z", revokedAt: null },
      { id: "l2", name: "Old phone", status: "revoked", routing: 1, locationMode: "manual", location: "Netherlands", createdAt: "2026-09-22T00:00:00Z", revokedAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(JSON.stringify(body.links)).not.toMatch(/must-not-leak|token|sub\//i);
  });

  it("still returns the customer, with links unavailable, when the link lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    linkRows.mockReturnValue({ data: null, error: { message: "boom" } });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.links).toBeNull();
  });
});
