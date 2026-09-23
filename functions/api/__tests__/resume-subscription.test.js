import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const maybeSingle = vi.fn();
const subscriptionsUpdate = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

vi.mock("stripe", () => {
  class StripeMock {
    constructor() {
      this.subscriptions = { update: subscriptionsUpdate };
    }
  }
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../resume-subscription.js");

function makeRequest() {
  return new Request("https://example.test/api/resume-subscription", {
    method: "POST",
    headers: { Authorization: "Bearer token-abc" },
  });
}

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  STRIPE_API_KEY: "sk_test_123",
};

beforeEach(() => {
  getClaims.mockReset().mockResolvedValue({
    data: {
      claims: {
        sub: "user-1",
        email: "user@example.com",
        role: "authenticated",
        amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
      },
    },
    error: null,
  });
  maybeSingle.mockReset();
  subscriptionsUpdate.mockReset();
});

describe("resume-subscription", () => {
  it("returns 404 when the user has no active subscription", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await onRequestPost({ env, request: makeRequest() });

    expect(res.status).toBe(404);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("clears cancel_at_period_end on Stripe when an active subscription exists", async () => {
    maybeSingle.mockResolvedValue({ data: { stripe_subscription_id: "sub_123" }, error: null });
    subscriptionsUpdate.mockResolvedValue({ id: "sub_123", cancel_at_period_end: false });

    const res = await onRequestPost({ env, request: makeRequest() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_123", { cancel_at_period_end: false });
  });
});
