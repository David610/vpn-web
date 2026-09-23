import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const getUserById = vi.fn();
let subMaybeSingle, vpnMaybeSingle, jobsOrder, jobsLimit, memberMaybeSingle, accountMaybeSingle, memberCount;

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
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), maybeSingle: subMaybeSingle };
      }
      if (table === "vpn_accounts") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vpnMaybeSingle };
      }
      if (table === "provisioning_jobs") {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
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
  vpnMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 1, vpn_user_id: "vpn-abc", node_id: "node-1", enabled: true }, error: null });
  jobsOrder = vi.fn();
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

  it("returns null vpnAccount when the user has none", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest(), params: { id: "user-1" } });
    const body = await res.json();
    expect(body.vpnAccount).toBeNull();
  });

  it("returns 500 (not a false null vpnAccount) when the vpn_accounts query errors", async () => {
    vpnMaybeSingle.mockResolvedValue({ data: null, error: { message: "db unavailable" } });
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
});
