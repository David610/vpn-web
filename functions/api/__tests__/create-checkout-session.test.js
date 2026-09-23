import { describe, it, expect, vi, beforeEach } from "vitest";

const getClaims = vi.fn();
const memberMaybeSingle = vi.fn();
const subscriptionMaybeSingle = vi.fn();
const accountMaybeSingle = vi.fn();
const reserveTrial = vi.fn();
const sessionsCreate = vi.fn();
const sessionsRetrieve = vi.fn();
const sessionsExpire = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getClaims },
    rpc: reserveTrial,
    from: vi.fn((table) => {
      if (table === "account_members") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: memberMaybeSingle,
        };
      }
      if (table === "subscriptions") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: subscriptionMaybeSingle,
        };
      }
      if (table === "customer_accounts") {
        const chain = {
          select: vi.fn(() => chain),
          update: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          is: vi.fn(() => chain),
          maybeSingle: accountMaybeSingle,
          then(onFulfilled, onRejected) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  })),
}));

vi.mock("stripe", () => {
  function StripeMock() {
    return {
      checkout: {
        sessions: {
          create: sessionsCreate,
          retrieve: sessionsRetrieve,
          expire: sessionsExpire,
        },
      },
    };
  }
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../create-checkout-session.js");

function makeRequest(body) {
  return new Request("https://example.test/api/create-checkout-session", {
    method: "POST",
    headers: {
      Authorization: "Bearer token-abc",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  getClaims.mockReset().mockResolvedValue({
    data: {
      claims: {
        sub: "user-1",
        email: "a@test.dev",
        role: "authenticated",
        amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
      },
    },
    error: null,
  });
  memberMaybeSingle.mockReset().mockResolvedValue({
    data: { account_id: "acct-1", role: "owner" },
    error: null,
  });
  subscriptionMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  accountMaybeSingle.mockReset().mockResolvedValue({
    data: { stripe_customer_id: null },
    error: null,
  });
  reserveTrial.mockReset().mockResolvedValue({
    data: "2026-09-23T15:00:00.000Z",
    error: null,
  });
  sessionsCreate.mockReset().mockResolvedValue({
    id: "cs_new",
    status: "open",
    url: "https://checkout.stripe.test/session",
  });
  sessionsRetrieve.mockReset();
  sessionsExpire.mockReset().mockResolvedValue({ id: "cs_new", status: "expired" });
});

describe("create-checkout-session", () => {
  it("requires a recent authentication event before starting billing", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          email: "a@test.dev",
          amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
        },
      },
      error: null,
    });
    const res = await onRequestPost({ env, request: makeRequest({ trial: false }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("reauth_required");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 409 without Stripe when a live/recent subscription exists", async () => {
    subscriptionMaybeSingle.mockResolvedValue({ data: { status: "active" }, error: null });
    const res = await onRequestPost({ env, request: makeRequest() });
    expect(res.status).toBe(409);
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(reserveTrial).not.toHaveBeenCalled();
  });

  it("starts a one-time 3-day trial", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ trial: true }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      url: "https://checkout.stripe.test/session",
      trial: true,
      resumed: false,
    });
    expect(reserveTrial).toHaveBeenCalledWith("reserve_free_trial", {
      p_account_id: "acct-1",
    });
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: { trial_period_days: 3 },
      })
    );
  });

  it("resumes an existing open trial Checkout instead of creating another", async () => {
    const reservedAt = new Date().toISOString();
    accountMaybeSingle.mockResolvedValue({
      data: {
        stripe_customer_id: null,
        trial_used_at: null,
        trial_reserved_at: reservedAt,
        trial_checkout_session_id: "cs_existing",
      },
      error: null,
    });
    sessionsRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      url: "https://checkout.stripe.test/existing",
    });

    const res = await onRequestPost({ env, request: makeRequest({ trial: true }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://checkout.stripe.test/existing",
      trial: true,
      resumed: true,
    });
    expect(sessionsRetrieve).toHaveBeenCalledWith("cs_existing");
    expect(reserveTrial).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("fails cleanly when the account has already used its trial", async () => {
    reserveTrial.mockResolvedValue({ data: null, error: null });
    accountMaybeSingle
      .mockResolvedValueOnce({
        data: {
          stripe_customer_id: null,
          trial_used_at: null,
          trial_reserved_at: null,
          trial_checkout_session_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          trial_used_at: "2026-09-22T12:00:00.000Z",
          trial_reserved_at: null,
          trial_checkout_session_id: null,
        },
        error: null,
      });

    const res = await onRequestPost({ env, request: makeRequest({ trial: true }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("trial_unavailable");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("supports Subscribe now without reserving or attaching a trial", async () => {
    const res = await onRequestPost({ env, request: makeRequest({ trial: false }) });
    expect(res.status).toBe(200);
    expect(reserveTrial).not.toHaveBeenCalled();
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.subscription_data).toBeUndefined();
  });

  it("reuses an existing Stripe customer when known", async () => {
    accountMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_existing" },
      error: null,
    });
    await onRequestPost({ env, request: makeRequest({ trial: false }) });
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" })
    );
    expect(sessionsCreate.mock.calls[0][0].customer_email).toBeUndefined();
  });
});
