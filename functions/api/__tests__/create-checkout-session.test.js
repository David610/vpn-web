import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const maybeSingle = vi.fn();
const memberMaybeSingle = vi.fn();
const sessionsCreate = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser },
    from: vi.fn((table) => {
      // getAccountForUser resolves the caller's account before the
      // subscription dedup check, so the two tables need separate results.
      if (table === "account_members") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: memberMaybeSingle,
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle,
      };
    }),
  })),
}));

vi.mock("stripe", () => {
  function StripeMock() {
    return {
      checkout: { sessions: { create: sessionsCreate } },
    };
  }
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../create-checkout-session.js");

function makeRequest() {
  return new Request("https://example.test/api/create-checkout-session", {
    method: "POST",
    headers: { Authorization: "Bearer token-abc" },
  });
}

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  STRIPE_API_KEY: "sk_test_123",
  STRIPE_PRICE_ID: "price_123",
  SITE_URL: "https://arcana.test",
};

beforeEach(() => {
  getUser.mockReset();
  maybeSingle.mockReset();
  memberMaybeSingle.mockReset().mockResolvedValue({
    data: { account_id: "acct-1", role: "owner" },
    error: null,
  });
  sessionsCreate.mockReset();
});

describe("create-checkout-session", () => {
  it("returns 409 without calling Stripe when the user already has an active subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@test.dev" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { status: "active" }, error: null });

    const res = await onRequestPost({ env, request: makeRequest() });

    expect(res.status).toBe(409);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 409 without calling Stripe when the user has a recent incomplete subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@test.dev" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { status: "incomplete" }, error: null });

    const res = await onRequestPost({ env, request: makeRequest() });

    expect(res.status).toBe(409);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("creates a Checkout session when the user has no active subscription", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "a@test.dev" } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.test/session" });

    const res = await onRequestPost({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.test/session");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});
