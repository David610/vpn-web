import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
const retrieve = vi.fn();
const update = vi.fn();

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));
vi.mock("stripe", () => {
  function StripeMock() {
    return { subscriptions: { retrieve, update } };
  }
  StripeMock.createFetchHttpClient = vi.fn();
  return { default: StripeMock };
});

const { onRequestPost } = await import("../seats.js");

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  STRIPE_API_KEY: "sk_test_123",
  STRIPE_SEAT_PRICE_ID: "price_seat",
};

function makeRequest(body) {
  return new Request("https://example.test/api/account/seats", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Stripe subscription carrying a base item and optionally a seat item. */
function stripeSub({ seatQuantity = null } = {}) {
  const items = [{ id: "si_base", price: { id: "price_base" }, quantity: 1 }];
  if (seatQuantity !== null) {
    items.push({ id: "si_seat", price: { id: "price_seat" }, quantity: seatQuantity });
  }
  return { id: "sub_123", items: { data: items } };
}

function seed({ role = "owner", members = 1, invites = 0, status = "active" } = {}) {
  return makeFakeSupabase(
    {
      customer_accounts: [{ id: "acct-1" }],
      account_members: Array.from({ length: members }, (_, i) => ({
        id: i + 1,
        account_id: "acct-1",
        user_id: i === 0 ? "user-1" : `user-${i + 1}`,
        role: i === 0 ? role : "member",
      })),
      subscriptions: status
        ? [
            {
              id: 1,
              account_id: "acct-1",
              stripe_subscription_id: "sub_123",
              status,
              extra_seats: 0,
            },
          ]
        : [],
      member_invites: Array.from({ length: invites }, (_, i) => ({
        id: i + 1,
        account_id: "acct-1",
        email: `pending${i}@example.com`,
        token_hash: String(i).repeat(64).slice(0, 64),
        expires_at: new Date(Date.now() + 86400_000).toISOString(),
        accepted_at: null,
        revoked_at: null,
      })),
    },
    { user: { id: "user-1", email: "owner@example.com" } }
  );
}

beforeEach(() => {
  retrieve.mockReset();
  update.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/account/seats", () => {
  it("adds a seat item when the subscription has none", async () => {
    db = seed();
    retrieve.mockResolvedValue(stripeSub());
    update.mockResolvedValue(stripeSub({ seatQuantity: 2 }));

    const res = await onRequestPost({ env, request: makeRequest({ quantity: 2 }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({ items: [{ price: "price_seat", quantity: 2 }] })
    );
    expect(body.seats).toMatchObject({ included: 3, extra: 2, limit: 5 });
    // Mirrored locally so the dashboard does not wait on webhook delivery.
    expect(db._tables.subscriptions[0].extra_seats).toBe(2);
  });

  it("updates the existing seat item rather than adding a second", async () => {
    db = seed();
    retrieve.mockResolvedValue(stripeSub({ seatQuantity: 1 }));
    update.mockResolvedValue(stripeSub({ seatQuantity: 3 }));

    await onRequestPost({ env, request: makeRequest({ quantity: 3 }) });

    expect(update).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({ items: [{ id: "si_seat", quantity: 3 }] })
    );
  });

  it("deletes the seat item at zero instead of leaving a zero-quantity line", async () => {
    // A zero-quantity item still prints on the invoice and reads as a bug.
    db = seed();
    retrieve.mockResolvedValue(stripeSub({ seatQuantity: 2 }));
    update.mockResolvedValue(stripeSub());

    const res = await onRequestPost({ env, request: makeRequest({ quantity: 0 }) });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({ items: [{ id: "si_seat", deleted: true }] })
    );
  });

  it("does not call Stripe when asked for zero and there is no seat item", async () => {
    db = seed();
    retrieve.mockResolvedValue(stripeSub());
    const res = await onRequestPost({ env, request: makeRequest({ quantity: 0 }) });
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });

  it("is absolute, so a double submit does not buy twice", async () => {
    db = seed();
    retrieve.mockResolvedValue(stripeSub({ seatQuantity: 2 }));
    update.mockResolvedValue(stripeSub({ seatQuantity: 2 }));

    await onRequestPost({ env, request: makeRequest({ quantity: 2 }) });
    await onRequestPost({ env, request: makeRequest({ quantity: 2 }) });

    // Both calls set the same total rather than incrementing.
    for (const call of update.mock.calls) {
      expect(call[1].items[0].quantity).toBe(2);
    }
  });

  it("refuses to release a seat that is occupied", async () => {
    // 5 people on a plan of 3 + 2 extra; dropping to 1 extra would bill for
    // fewer seats than there are members. Making the owner remove someone
    // first is better than silently evicting whoever sorts last.
    db = seed({ members: 5 });
    retrieve.mockResolvedValue(stripeSub({ seatQuantity: 2 }));

    const res = await onRequestPost({ env, request: makeRequest({ quantity: 1 }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "seats_in_use", minimum: 2 });
    expect(update).not.toHaveBeenCalled();
  });

  it("counts a pending invite as occupying a seat when releasing", async () => {
    db = seed({ members: 3, invites: 1 });
    retrieve.mockResolvedValue(stripeSub({ seatQuantity: 1 }));

    const res = await onRequestPost({ env, request: makeRequest({ quantity: 0 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ minimum: 1 });
  });

  it("refuses a member who is not the owner", async () => {
    db = seed({ role: "member" });
    const res = await onRequestPost({ env, request: makeRequest({ quantity: 1 }) });
    expect(res.status).toBe(403);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("refuses an account with no live subscription", async () => {
    db = seed({ status: null });
    const res = await onRequestPost({ env, request: makeRequest({ quantity: 1 }) });
    expect(res.status).toBe(403);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["an absurd count", 9999],
    ["a string", "2"],
  ])("rejects %s without calling Stripe", async (_label, quantity) => {
    db = seed();
    const res = await onRequestPost({ env, request: makeRequest({ quantity }) });
    expect(res.status).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("reports unavailable when no seat price is configured", async () => {
    db = seed();
    const res = await onRequestPost({
      env: { ...env, STRIPE_SEAT_PRICE_ID: undefined },
      request: makeRequest({ quantity: 1 }),
    });
    expect(res.status).toBe(503);
    expect(retrieve).not.toHaveBeenCalled();
  });
});
