import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const adminMaybeSingle = vi.fn();
const countQueries = {};

// A minimal chainable + thenable stand-in for the Supabase query builder.
// It supports being awaited directly (no further chaining, as with the
// plain `.select(...)` count queries and the `nodes` row query), and also
// supports `.eq(...)` / `.in(...)` being chained onto it, resolving to a
// value that depends on the filter actually applied.
function chainable(resolveFn) {
  return {
    eq: vi.fn((column, value) => Promise.resolve(resolveFn({ eq: [column, value] }))),
    in: vi.fn((column, values) => Promise.resolve(resolveFn({ in: [column, values] }))),
    then: (onFulfilled, onRejected) => Promise.resolve(resolveFn({})).then(onFulfilled, onRejected),
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn((table) => {
      if (table === "admin_users") {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: adminMaybeSingle };
      }
      return countQueries[table]();
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

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({ data: { claims: { sub: "admin-1", aal: "aal2" } }, error: null });
  adminMaybeSingle.mockReset().mockResolvedValue({ data: { role: "owner" }, error: null });
});

describe("GET /api/admin/overview", () => {
  it("returns 401 when not an admin", async () => {
    adminMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(401);
  });

  it("returns aggregate counts for an admin", async () => {
    // subscriptions: three .eq/.in-filtered count queries plus one
    // unfiltered total, all against the same table.
    countQueries.subscriptions = () => ({
      select: vi.fn(() =>
        chainable(({ in: inArgs, eq: eqArgs }) => {
          if (inArgs && inArgs[0] === "status") return { count: 12, data: null, error: null }; // active/trialing
          if (eqArgs && eqArgs[1] === "past_due") return { count: 3, data: null, error: null };
          if (eqArgs && eqArgs[1] === "canceled") return { count: 2, data: null, error: null };
          return { count: 20, data: null, error: null }; // total, no filter chained
        })
      ),
    });

    // vpn_accounts: single unfiltered count query.
    countQueries.vpn_accounts = () => ({
      select: vi.fn(() => chainable(() => ({ count: 15, data: null, error: null }))),
    });

    // provisioning_jobs: three .eq-filtered count queries.
    countQueries.provisioning_jobs = () => ({
      select: vi.fn(() =>
        chainable(({ eq: eqArgs }) => {
          if (eqArgs && eqArgs[1] === "pending") return { count: 4, data: null, error: null };
          if (eqArgs && eqArgs[1] === "claimed") return { count: 1, data: null, error: null };
          if (eqArgs && eqArgs[1] === "failed") return { count: 2, data: null, error: null };
          return { count: 0, data: null, error: null };
        })
      ),
    });

    // nodes: plain `.select("last_seen_at, revoked_at")`, no filters,
    // returns row data used to classify online/offline (45s threshold).
    const now = Date.now();
    const nodeRows = [
      { last_seen_at: new Date(now - 30_000).toISOString(), revoked_at: null }, // online (<45s)
      { last_seen_at: new Date(now - 5 * 60_000).toISOString(), revoked_at: null }, // offline (stale)
      { last_seen_at: new Date(now - 10_000).toISOString(), revoked_at: new Date(now).toISOString() }, // revoked, excluded entirely
      { last_seen_at: null, revoked_at: null }, // offline (never seen)
    ];
    countQueries.nodes = () => ({
      select: vi.fn(() => chainable(() => ({ count: null, data: nodeRows, error: null }))),
    });

    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      customers: { total: 20, active: 12, past_due: 3, canceled: 2 },
      vpn: { accounts: 15 },
      jobs: { pending: 4, claimed: 1, failed: 2 },
      nodes: { online: 1, offline: 2 },
    });
  });

  it("returns 500 (not a zeroed/empty success response) when one query errors", async () => {
    // subscriptions: three .eq/.in-filtered count queries plus one
    // unfiltered total — all succeed here.
    countQueries.subscriptions = () => ({
      select: vi.fn(() =>
        chainable(({ in: inArgs, eq: eqArgs }) => {
          if (inArgs && inArgs[0] === "status") return { count: 12, data: null, error: null };
          if (eqArgs && eqArgs[1] === "past_due") return { count: 3, data: null, error: null };
          if (eqArgs && eqArgs[1] === "canceled") return { count: 2, data: null, error: null };
          return { count: 20, data: null, error: null };
        })
      ),
    });

    // vpn_accounts: simulate a PostgREST-level failure — resolves with
    // { data: null, error } rather than rejecting, as the real client does.
    countQueries.vpn_accounts = () => ({
      select: vi.fn(() => chainable(() => ({ count: null, data: null, error: { message: "connection reset" } }))),
    });

    countQueries.provisioning_jobs = () => ({
      select: vi.fn(() =>
        chainable(({ eq: eqArgs }) => {
          if (eqArgs && eqArgs[1] === "pending") return { count: 4, data: null, error: null };
          if (eqArgs && eqArgs[1] === "claimed") return { count: 1, data: null, error: null };
          if (eqArgs && eqArgs[1] === "failed") return { count: 2, data: null, error: null };
          return { count: 0, data: null, error: null };
        })
      ),
    });

    countQueries.nodes = () => ({
      select: vi.fn(() => chainable(() => ({ count: null, data: [], error: null }))),
    });

    const res = await onRequestGet({ env, request: makeRequest() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error" });
  });
});
