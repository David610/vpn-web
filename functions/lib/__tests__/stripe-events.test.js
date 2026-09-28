import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleSubscriptionTrialing,
} from "../stripe-events.js";
import { makeFakeSupabase, seedAccount } from "./fake-supabase.js";
import { applyLegacyExpiryGrace } from "../stripe-fields.js";

const PERIOD_END_UNIX = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END_ISO = new Date(PERIOD_END_UNIX * 1000).toISOString();
// F-19/C-04: node-facing expiry (what CREATE_USER/SET_EXPIRY payloads and
// entitlement.serviceExpiresAt carry) is the raw period end plus a 72h grace
// — see stripe-fields.js. Anything asserting on the *device-facing* expiry
// must use this, not PERIOD_END_ISO directly.
const NODE_EXPIRY_ISO = applyLegacyExpiryGrace(PERIOD_END_ISO);

function invoice({ billingReason, subscriptionId = "sub_123" }) {
  return {
    id: "in_1",
    billing_reason: billingReason,
    subscription: subscriptionId,
    lines: { data: [{ period: { end: PERIOD_END_UNIX } }] },
  };
}

const jobsOf = (db) => db._tables.provisioning_jobs;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleCheckoutSessionCompleted", () => {
  it("records the Stripe customer on the account, not on the subscription", async () => {
    // The billing portal needs a customer id even when an account has no
    // live subscription, which a subscriptions row cannot supply.
    const db = makeFakeSupabase({
      customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
      account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    });

    await handleCheckoutSessionCompleted(db, {
      mode: "subscription",
      client_reference_id: "user-1",
      customer: "cus_123",
      subscription: "sub_123",
    });

    expect(db._tables.customer_accounts[0].stripe_customer_id).toBe("cus_123");
    expect(db._tables.subscriptions).toHaveLength(1);
    expect(db._tables.subscriptions[0]).toMatchObject({
      account_id: "acct-1",
      stripe_subscription_id: "sub_123",
      status: "incomplete",
    });
  });

  it("stores the subscription name chosen at checkout", async () => {
    const db = makeFakeSupabase({
      customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
      account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    });

    await handleCheckoutSessionCompleted(db, {
      mode: "subscription",
      client_reference_id: "user-1",
      customer: "cus_123",
      subscription: "sub_family",
      metadata: { subscription_name: "Family" },
    });

    expect(db._tables.subscriptions[0].name).toBe("Family");
  });

  it("throws when the checkout user has no account membership", async () => {
    // handle_new_user gives every user an account, so this is data
    // corruption rather than a race — it must not be swallowed.
    const db = makeFakeSupabase({});
    await expect(
      handleCheckoutSessionCompleted(db, {
        mode: "subscription",
        client_reference_id: "ghost",
        customer: "cus_123",
        subscription: "sub_123",
      })
    ).rejects.toThrow(/no account_members row/);
  });

  it("ignores non-subscription checkout sessions", async () => {
    const db = makeFakeSupabase({});
    await handleCheckoutSessionCompleted(db, { mode: "payment" });
    expect(db.from).not.toHaveBeenCalled();
  });

  describe("F-31/C-04 base price validation", () => {
    const env = { STRIPE_PRICE_ID: "price_good" };

    function fakeStripe(priceId) {
      return {
        checkout: {
          sessions: {
            listLineItems: vi.fn().mockResolvedValue({
              data: [{ price: { id: priceId }, quantity: 1 }],
            }),
          },
        },
      };
    }

    it("refuses to map an unapproved base price: no subscriptions row, alert raised", async () => {
      const db = makeFakeSupabase({
        customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
        account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      });
      const stripe = fakeStripe("price_evil");

      await handleCheckoutSessionCompleted(
        db,
        {
          id: "cs_1",
          mode: "subscription",
          client_reference_id: "user-1",
          customer: "cus_123",
          subscription: "sub_evil",
        },
        stripe,
        env
      );

      expect(stripe.checkout.sessions.listLineItems).toHaveBeenCalledWith("cs_1", {
        expand: ["data.price"],
      });
      // No subscriptions row was created for this subscription id, so no
      // later invoice.paid / customer.subscription.updated can ever find one
      // to flip to "active" — device_entitlement() never grants capacity.
      expect(db._tables.subscriptions).toHaveLength(0);
      // Portal access is unaffected: the Stripe customer is still recorded.
      expect(db._tables.customer_accounts[0].stripe_customer_id).toBe("cus_123");
      expect(db._tables.operational_alerts).toHaveLength(1);
      expect(db._tables.operational_alerts[0]).toMatchObject({
        alert_type: "checkout_unapproved_base_price",
        severity: "critical",
      });
    });

    it("still maps normally when the base price is approved", async () => {
      const db = makeFakeSupabase({
        customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
        account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      });
      const stripe = fakeStripe("price_good");

      await handleCheckoutSessionCompleted(
        db,
        {
          id: "cs_2",
          mode: "subscription",
          client_reference_id: "user-1",
          customer: "cus_123",
          subscription: "sub_123",
        },
        stripe,
        env
      );

      expect(db._tables.subscriptions).toHaveLength(1);
      expect(db._tables.subscriptions[0]).toMatchObject({
        stripe_subscription_id: "sub_123",
        status: "incomplete",
      });
      expect(db._tables.operational_alerts).toHaveLength(0);
    });

    it("a subsequent invoice.paid for the unmapped subscription never provisions", async () => {
      // End-to-end confirmation of the narrative: blocking the mapping at
      // checkout means the normal provisioning trigger structurally can't
      // find a row to work from.
      const db = makeFakeSupabase({
        customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
        account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      });
      const stripe = fakeStripe("price_evil");
      await handleCheckoutSessionCompleted(
        db,
        {
          id: "cs_3",
          mode: "subscription",
          client_reference_id: "user-1",
          customer: "cus_123",
          subscription: "sub_evil",
        },
        stripe,
        env
      );

      await expect(
        handleInvoicePaid(db, invoice({ billingReason: "subscription_create", subscriptionId: "sub_evil" }))
      ).rejects.toThrow(/no subscriptions row/);
      expect(jobsOf(db)).toHaveLength(0);
    });

    it("does not fetch line items or block anything when no allowlist is configured", async () => {
      const db = makeFakeSupabase({
        customer_accounts: [{ id: "acct-1", stripe_customer_id: null }],
        account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      });
      const stripe = fakeStripe("price_anything");

      await handleCheckoutSessionCompleted(
        db,
        {
          id: "cs_4",
          mode: "subscription",
          client_reference_id: "user-1",
          customer: "cus_123",
          subscription: "sub_123",
        },
        stripe,
        {}
      );

      expect(stripe.checkout.sessions.listLineItems).not.toHaveBeenCalled();
      expect(db._tables.subscriptions).toHaveLength(1);
    });
  });
});

describe("handleInvoicePaid — first invoice", () => {
  it("enqueues one CREATE_USER per member, keyed per member", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_create" }));

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    // The member got a device, and the job creates THAT device's identity
    // on the node it was placed on (legacy mode: node-1).
    const [device] = db._tables.devices;
    expect(device).toMatchObject({ account_id: "acct-1", user_id: "user-1", status: "ACTIVE" });
    expect(jobs[0]).toMatchObject({
      job_type: "CREATE_USER",
      node_id: "node-1",
      device_id: device.id,
      idempotency_key: `create-user:sub_123:create:${device.id}:node-1`,
      payload: { user_id: "user-1", device_id: device.id, expires_at: NODE_EXPIRY_ISO },
    });
    expect(db._tables.subscriptions[0].status).toBe("active");
  });

  it("is a no-op on redelivery (idempotency key already present)", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));
    const paid = invoice({ billingReason: "subscription_create" });

    await handleInvoicePaid(db, paid);
    await handleInvoicePaid(db, paid);

    expect(jobsOf(db)).toHaveLength(1);
  });
});

describe("handleInvoicePaid — renewal", () => {
  it("extends every provisioned seat, one SET_EXPIRY per VPN account", async () => {
    // The fan-out that the pre-account code could not express: a renewal has
    // to push the new expiry to all three seats, not just the owner's.
    const db = makeFakeSupabase(
      seedAccount({
        members: [
          { userId: "user-1", role: "owner" },
          { userId: "user-2", role: "member" },
          { userId: "user-3", role: "member" },
        ],
        provisioned: [
          { userId: "user-1", vpnUserId: "vpn-1" },
          { userId: "user-2", vpnUserId: "vpn-2" },
          { userId: "user-3", vpnUserId: "vpn-3" },
        ],
      })
    );

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.job_type === "SET_EXPIRY")).toBe(true);
    expect(jobs.map((j) => j.payload.vpn_user_id).sort()).toEqual([
      "vpn-1",
      "vpn-2",
      "vpn-3",
    ]);
    // Keys include the vpn_account so three seats produce three jobs rather
    // than colliding on one subscription-scoped key.
    expect(new Set(jobs.map((j) => j.idempotency_key)).size).toBe(3);
    expect(jobs.every((j) => j.payload.expires_at === NODE_EXPIRY_ISO)).toBe(true);
  });

  it("F-19: a webhook delayed hours past the period boundary still resolves to periodEnd + 72h, not less", async () => {
    // Stripe finalizes renewal invoices roughly an hour after the new period
    // starts, and delivery/processing can add more delay on top. The grace
    // window is computed from the invoice's own period end, not from when
    // this handler happens to run, so an arbitrarily late-processed
    // invoice.paid must still resolve to exactly periodEnd + 72h.
    const db = makeFakeSupabase(
      seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] })
    );

    // Advance the clock 6 hours to stand in for "Stripe finalized this and
    // delivery/retry delay pushed processing well past the period start" —
    // the computation must not depend on wall-clock time at all, so the
    // result has to be identical to running it "on time".
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    try {
      await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));
    } finally {
      vi.useRealTimers();
    }

    const jobs = jobsOf(db);
    expect(jobs[0].payload.expires_at).toBe(NODE_EXPIRY_ISO);
    // Never merely the raw period end.
    expect(jobs[0].payload.expires_at).not.toBe(PERIOD_END_ISO);
  });

  it("only extends seats on the renewing account", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({
        provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }],
      }),
    });
    // A bystander account that must not receive any job.
    db._tables.account_members.push({ account_id: "acct-2", user_id: "user-9", role: "owner" });
    db._tables.vpn_accounts.push({ id: 99, user_id: "user-9", vpn_user_id: "vpn-9", node_id: "node-1", enabled: true });

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.vpn_user_id).toBe("vpn-1");
  });

  it("re-enables a VPN account when a late payment recovers it from unpaid", async () => {
    const db = makeFakeSupabase(
      seedAccount({
        status: "unpaid",
        provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }],
      })
    );
    db._tables.vpn_accounts[0].enabled = false;

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    const jobs = jobsOf(db);
    expect(jobs.map((j) => j.job_type).sort()).toEqual(["ENABLE_USER", "SET_EXPIRY"]);
    expect(jobs.find((j) => j.job_type === "ENABLE_USER")).toMatchObject({
      payload: { vpn_user_id: "vpn-1", user_id: "user-1" },
    });
  });

  it("does not shorten an indefinite support grant on renewal", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({
        status: "active",
        provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }],
      }),
      admin_entitlements: [
        {
          id: "grant-1",
          account_id: "acct-1",
          status: "active",
          starts_at: "2026-01-01T00:00:00Z",
          expires_at: null,
          seat_limit: 3,
          reason: "support",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: "CLEAR_EXPIRY",
      payload: { vpn_user_id: "vpn-1" },
    });
  });

  it("throws so Stripe retries when no seat is provisioned yet", async () => {
    // A renewal only fires for a subscription whose first invoice already
    // succeeded, so the CREATE_USER jobs exist and the rows will appear once
    // the agent catches up. Retrying is correct; silently extending nobody
    // is not.
    const db = makeFakeSupabase(seedAccount({ provisioned: [] }));
    await expect(
      handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }))
    ).rejects.toThrow(/first VPN identity is not created yet/);
  });

  it("does not enqueue a duplicate CREATE_USER on the retry while the first is in flight", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));
    await handleInvoicePaid(db, invoice({ billingReason: "subscription_create" }));
    expect(jobsOf(db)).toHaveLength(1);
    // The renewal arrives before the agent claimed the first create: it
    // throws (so Stripe retries) and must not add a second create for the
    // same device and node.
    await expect(
      handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }))
    ).rejects.toThrow(/not created yet/);
    await expect(
      handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }))
    ).rejects.toThrow(/not created yet/);
    expect(jobsOf(db).filter((j) => j.job_type === "CREATE_USER")).toHaveLength(1);
  });

  it("skips provisioning for an invoice that lands after cancellation", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "canceled" }));
    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));
    expect(jobsOf(db)).toHaveLength(0);
  });
});

describe("handleSubscriptionUpdated", () => {
  it("persists cancel_at_period_end from the Stripe subscription object", async () => {
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(db, {
      id: "sub_123",
      status: "active",
      cancel_at_period_end: true,
      current_period_end: PERIOD_END_UNIX,
    });

    expect(db._tables.subscriptions[0].cancel_at_period_end).toBe(true);
  });

  it("disables every seat when dunning ends in unpaid", async () => {
    const db = makeFakeSupabase(
      seedAccount({
        members: [
          { userId: "user-1", role: "owner" },
          { userId: "user-2", role: "member" },
        ],
        provisioned: [
          { userId: "user-1", vpnUserId: "vpn-1" },
          { userId: "user-2", vpnUserId: "vpn-2" },
        ],
      })
    );

    await handleSubscriptionUpdated(db, {
      id: "sub_123",
      status: "unpaid",
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_UNIX,
    });

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.job_type === "DISABLE_USER")).toBe(true);
    expect(jobs.map((j) => j.payload.vpn_user_id).sort()).toEqual(["vpn-1", "vpn-2"]);
  });

  it("mirrors the seat-pack item quantity into extra_seats, converted to seats", async () => {
    // Stripe owns the pack count; extra_seats is only ever a mirror,
    // expressed in seats (packs * SEAT_PACK_SIZE). Packs bought through our
    // API and packs adjusted directly in the Stripe dashboard both arrive as
    // this event, so syncing here covers both — this is the mechanism that
    // reconciles a dashboard-initiated seat-pack change into the DB.
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: {
          data: [
            { id: "si_base", price: { id: "price_base" }, quantity: 1 },
            { id: "si_seat", price: { id: "price_seat" }, quantity: 4 },
          ],
        },
      },
      "price_seat"
    );

    // 4 packs * SEAT_PACK_SIZE (3) = 12 extra seats.
    expect(db._tables.subscriptions[0].extra_seats).toBe(12);
  });

  it("converges extra_seats from a dashboard-initiated pack downgrade without evicting anyone", async () => {
    // No silent eviction: a seat-pack quantity reduced directly in the
    // Stripe dashboard (not through our purchase API's own guard) still
    // must not cause this webhook to touch account_members or
    // vpn_accounts. Only a canceled/unpaid subscription status enqueues
    // DISABLE_USER jobs — a live subscription's seat-pack change never
    // does, regardless of how far below current membership it drops.
    const db = makeFakeSupabase(
      seedAccount({
        members: [
          { userId: "user-1", role: "owner" },
          { userId: "user-2", role: "member" },
          { userId: "user-3", role: "member" },
          { userId: "user-4", role: "member" },
          { userId: "user-5", role: "member" },
        ],
        provisioned: [
          { userId: "user-1", vpnUserId: "vpn-1" },
          { userId: "user-2", vpnUserId: "vpn-2" },
          { userId: "user-3", vpnUserId: "vpn-3" },
          { userId: "user-4", vpnUserId: "vpn-4" },
          { userId: "user-5", vpnUserId: "vpn-5" },
        ],
      })
    );
    const vpnAccountsBefore = JSON.stringify(db._tables.vpn_accounts);
    const membersBefore = JSON.stringify(db._tables.account_members);

    // 5 members need at least 2 extra seats (INCLUDED_SEATS=3), but the
    // dashboard drops the seat-pack item to 0 — well below what's in use.
    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_base" }, quantity: 1 }] },
      },
      "price_seat"
    );

    expect(db._tables.subscriptions[0].extra_seats).toBe(0);
    expect(jobsOf(db)).toHaveLength(0);
    expect(db._tables.vpn_accounts).toEqual(JSON.parse(vpnAccountsBefore));
    expect(db._tables.account_members).toEqual(JSON.parse(membersBefore));
  });

  it("records zero extra seats when the seat item is gone", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({}),
      subscriptions: [
        { id: 1, account_id: "acct-1", stripe_subscription_id: "sub_123", status: "active", extra_seats: 3 },
      ],
    });

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_base" }, quantity: 1 }] },
      },
      "price_seat"
    );

    // Must fall back to 0, not leave the stale 3 in place — otherwise a
    // released seat keeps granting capacity nobody is paying for.
    expect(db._tables.subscriptions[0].extra_seats).toBe(0);
  });

  it("does not mistake the base item for the seat item", async () => {
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_base" }, quantity: 7 }] },
      },
      "price_seat"
    );

    expect(db._tables.subscriptions[0].extra_seats).toBe(0);
  });

  it("leaves seats alone while the subscription is merely active", async () => {
    const db = makeFakeSupabase(
      seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] })
    );

    await handleSubscriptionUpdated(db, {
      id: "sub_123",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_UNIX,
    });

    expect(jobsOf(db)).toHaveLength(0);
  });

  describe("F-19/C-04 grace + expiry push", () => {
    const OLD_PERIOD_END_ISO = "2029-12-01T00:00:00.000Z";
    const NEW_PERIOD_END_UNIX = PERIOD_END_UNIX; // 2030-01-01T00:00:00Z
    const NEW_NODE_EXPIRY_ISO = NODE_EXPIRY_ISO; // NEW_PERIOD_END + 72h

    it("pushes the grace-extended expiry when the period end advances — no invoice.paid needed", async () => {
      const db = makeFakeSupabase({
        ...seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
        subscriptions: [
          {
            id: 1,
            account_id: "acct-1",
            stripe_subscription_id: "sub_123",
            status: "active",
            current_period_end: OLD_PERIOD_END_ISO,
            extra_seats: 0,
          },
        ],
      });

      await handleSubscriptionUpdated(db, {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: NEW_PERIOD_END_UNIX,
      });

      const jobs = jobsOf(db);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        job_type: "SET_EXPIRY",
        payload: { vpn_user_id: "vpn-1", expires_at: NEW_NODE_EXPIRY_ISO },
      });
      // The row's own (raw, non-grace) period end is exactly what Stripe
      // reported — grace never leaks into billing-facing fields.
      expect(db._tables.subscriptions[0].current_period_end).toBe(PERIOD_END_ISO);
    });

    it("does not push when the period end is unchanged (e.g. a same-cycle pack purchase)", async () => {
      const db = makeFakeSupabase({
        ...seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
        subscriptions: [
          {
            id: 1,
            account_id: "acct-1",
            stripe_subscription_id: "sub_123",
            status: "active",
            current_period_end: PERIOD_END_ISO,
            extra_seats: 0,
          },
        ],
      });

      await handleSubscriptionUpdated(db, {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX, // same period end as already stored
      });

      expect(jobsOf(db)).toHaveLength(0);
    });

    it("never pushes on a terminal transition — DISABLE_USER only, immediately, no grace", async () => {
      const db = makeFakeSupabase({
        ...seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
        subscriptions: [
          {
            id: 1,
            account_id: "acct-1",
            stripe_subscription_id: "sub_123",
            status: "active",
            current_period_end: OLD_PERIOD_END_ISO,
            extra_seats: 0,
          },
        ],
      });

      await handleSubscriptionUpdated(db, {
        id: "sub_123",
        status: "canceled",
        cancel_at_period_end: false,
        current_period_end: NEW_PERIOD_END_UNIX, // even though the period "advanced"
      });

      const jobs = jobsOf(db);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].job_type).toBe("DISABLE_USER");
    });
  });
});

describe("handleSubscriptionDeleted", () => {
  it("disables every provisioned seat on the account", async () => {
    const db = makeFakeSupabase(
      seedAccount({
        members: [
          { userId: "user-1", role: "owner" },
          { userId: "user-2", role: "member" },
        ],
        provisioned: [
          { userId: "user-1", vpnUserId: "vpn-1" },
          { userId: "user-2", vpnUserId: "vpn-2" },
        ],
      })
    );

    await handleSubscriptionDeleted(db, { id: "sub_123" });

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.job_type === "DISABLE_USER")).toBe(true);
    // One job per identity, each targeted at the node that identity lives on.
    expect(jobs.map((j) => j.idempotency_key).sort()).toEqual([
      "disable-user:sub_123:disable:1",
      "disable-user:sub_123:disable:2",
    ]);
    expect(jobs.map((j) => [j.vpn_account_id, j.node_id]).sort()).toEqual([
      [1, "node-1"],
      [2, "node-1"],
    ]);
    expect(db._tables.subscriptions[0].status).toBe("canceled");
  });

  it("does not double-enqueue when updated and deleted both fire", async () => {
    // Stripe can send both for one cancellation; the shared key shape makes
    // the second pass a no-op instead of a second round of jobs.
    const db = makeFakeSupabase(
      seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] })
    );

    await handleSubscriptionUpdated(db, {
      id: "sub_123",
      status: "canceled",
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_UNIX,
    });
    await handleSubscriptionDeleted(db, { id: "sub_123" });

    expect(jobsOf(db)).toHaveLength(1);
  });

  it("returns cleanly when the subscription was never provisioned", async () => {
    // No VPN accounts and no CREATE_USER job ever enqueued: there is
    // genuinely nothing to disable, and retrying would never find a row.
    const db = makeFakeSupabase(seedAccount({ provisioned: [] }));
    await expect(handleSubscriptionDeleted(db, { id: "sub_123" })).resolves.toBeUndefined();
    expect(jobsOf(db)).toHaveLength(0);
  });

  it("throws so Stripe retries when provisioning is still in flight", async () => {
    // A CREATE_USER job exists but the agent has not produced the
    // vpn_accounts row yet — a real race, and the opposite of the case above.
    const db = makeFakeSupabase(seedAccount({ provisioned: [] }));
    db._tables.provisioning_jobs.push({
      id: 1,
      idempotency_key: "create-user:sub_123:user-1",
      job_type: "CREATE_USER",
    });

    await expect(handleSubscriptionDeleted(db, { id: "sub_123" })).rejects.toThrow(
      /no VPN identities/
    );
  });

  it("returns cleanly for an unknown subscription", async () => {
    const db = makeFakeSupabase({});
    await expect(handleSubscriptionDeleted(db, { id: "sub_nope" })).resolves.toBeUndefined();
  });
});

const TRIAL_END_UNIX = 1893456000;
const TRIAL_END_ISO = new Date(TRIAL_END_UNIX * 1000).toISOString();
// F-19/C-04: device-facing expiry gets the same 72h grace during a trial as
// any other legacy node expiry (the mitigation is for webhook/enforcement
// lag, not specific to paid periods). TRIAL_END_ISO itself (the raw value
// stored on subscriptions.current_period_end) is never grace-adjusted.
const TRIAL_NODE_EXPIRY_ISO = applyLegacyExpiryGrace(TRIAL_END_ISO);

describe("handleSubscriptionTrialing", () => {
  const trialing = (overrides = {}) => ({
    id: "sub_123",
    status: "trialing",
    trial_end: TRIAL_END_UNIX,
    ...overrides,
  });

  it("provisions every member for the trial period without any payment", async () => {
    // The whole point of a trial is service before payment, so waiting for
    // a paid invoice would mean the trial grants nothing.
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionTrialing(db, trialing());

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    const [device] = db._tables.devices;
    expect(jobs[0]).toMatchObject({
      job_type: "CREATE_USER",
      idempotency_key: `create-user:sub_123:create:${device.id}:node-1`,
      payload: { user_id: "user-1", device_id: device.id, expires_at: TRIAL_NODE_EXPIRY_ISO },
    });
    expect(db._tables.subscriptions[0]).toMatchObject({
      status: "trialing",
      current_period_end: TRIAL_END_ISO,
    });
  });

  it("expires access at the trial end plus grace, not at some later date", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));
    await handleSubscriptionTrialing(db, trialing());
    expect(jobsOf(db)[0].payload.expires_at).toBe(TRIAL_NODE_EXPIRY_ISO);
  });

  it("does not double-provision when a zero-amount invoice also arrives", async () => {
    // Stripe's behaviour around a $0 invoice at trial start is not something
    // this code should depend on. Whichever fires first provisions; the
    // other must be a no-op under the same idempotency key.
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionTrialing(db, trialing());
    await handleInvoicePaid(db, invoice({ billingReason: "subscription_create" }));

    expect(jobsOf(db)).toHaveLength(1);
  });

  it("is a no-op in the other order too", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_create" }));
    await handleSubscriptionTrialing(db, trialing());

    expect(jobsOf(db)).toHaveLength(1);
  });

  it("provisions a seat for every member of a shared plan", async () => {
    const db = makeFakeSupabase(
      seedAccount({
        status: "incomplete",
        members: [
          { userId: "user-1", role: "owner" },
          { userId: "user-2", role: "member" },
        ],
      })
    );

    await handleSubscriptionTrialing(db, trialing());

    expect(jobsOf(db)).toHaveLength(2);
  });

  it("throws so Stripe retries when the checkout mapping has not landed", async () => {
    const db = makeFakeSupabase({});
    await expect(handleSubscriptionTrialing(db, trialing())).rejects.toThrow(
      /no subscriptions row/
    );
  });

  it("throws rather than guessing an expiry when trial_end is missing", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));
    await expect(
      handleSubscriptionTrialing(db, trialing({ trial_end: undefined }))
    ).rejects.toThrow(/no trial_end/);
    expect(jobsOf(db)).toHaveLength(0);
  });

  it("extends expiry via SET_EXPIRY when the trial converts", async () => {
    // Conversion invoices carry billing_reason subscription_cycle, so they
    // take the renewal path against the seats the trial provisioned.
    const db = makeFakeSupabase(
      seedAccount({
        status: "trialing",
        provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }],
      })
    );

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: "SET_EXPIRY",
      payload: { vpn_user_id: "vpn-1", expires_at: NODE_EXPIRY_ISO },
    });
  });
});

// F-02/C-02/C-14: Stripe does not guarantee webhook delivery order. Each of
// these ends at Stripe's actual final state regardless of the order the
// events reach this handler, by comparing the delivered event's own
// creation time (T1 < T2 < T3 below) against subscriptions.stripe_synced_at
// and by making "canceled" sticky.
describe("event ordering (F-02/C-02/C-14)", () => {
  const T1 = "2026-01-01T00:00:00.000Z";
  const T2 = "2026-01-01T00:05:00.000Z";
  const T3 = "2026-01-01T00:10:00.000Z";

  it("updated-after-deleted: a stale reactivation arriving after cancellation is rejected", async () => {
    const db = makeFakeSupabase(seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }));

    await handleSubscriptionDeleted(db, { id: "sub_123" }, {}, T2);
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T1
    );

    expect(db._tables.subscriptions[0].status).toBe("canceled");
  });

  it("duplicate deleted: a redelivered/late deleted event stays a no-op canceled row", async () => {
    const db = makeFakeSupabase(seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }));

    await handleSubscriptionDeleted(db, { id: "sub_123" }, {}, T2);
    await handleSubscriptionDeleted(db, { id: "sub_123" }, {}, T1);

    expect(db._tables.subscriptions[0].status).toBe("canceled");
    expect(jobsOf(db).filter((j) => j.job_type === "DISABLE_USER")).toHaveLength(1);
  });

  it("duplicate updated: a stale updated event never overwrites a newer one's fields", async () => {
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "past_due",
        cancel_at_period_end: true,
        current_period_end: PERIOD_END_UNIX,
      },
      undefined,
      {},
      T2
    );
    // A stale redelivery of an OLDER state (active, no cancel) arrives late.
    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
      },
      undefined,
      {},
      T1
    );

    expect(db._tables.subscriptions[0]).toMatchObject({
      status: "past_due",
      cancel_at_period_end: true,
    });
  });

  it("late invoice.paid: an invoice from before cancellation must not resurrect the subscription", async () => {
    const db = makeFakeSupabase(seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }));

    await handleSubscriptionDeleted(db, { id: "sub_123" }, {}, T2);
    await handleInvoicePaid(db, {
      id: "in_late",
      created: new Date(T1).getTime() / 1000,
      billing_reason: "subscription_cycle",
      subscription: "sub_123",
      lines: { data: [{ period: { end: PERIOD_END_UNIX } }] },
    });

    expect(db._tables.subscriptions[0].status).toBe("canceled");
    expect(jobsOf(db).filter((j) => j.job_type === "SET_EXPIRY")).toHaveLength(0);
  });

  it("payment failed then a late invoice.paid for the failed cycle is rejected", async () => {
    const db = makeFakeSupabase(seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "unpaid", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T2
    );
    await handleInvoicePaid(db, {
      id: "in_late",
      created: new Date(T1).getTime() / 1000,
      billing_reason: "subscription_create",
      subscription: "sub_123",
      lines: { data: [{ period: { end: PERIOD_END_UNIX } }] },
    });

    expect(db._tables.subscriptions[0].status).toBe("unpaid");
  });

  it("trial transitions: a stale trialing redelivery cannot revert an activated subscription", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "trialing" }));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T2
    );
    await handleSubscriptionTrialing(db, { id: "sub_123", status: "trialing", trial_end: PERIOD_END_UNIX }, {}, T1);

    expect(db._tables.subscriptions[0].status).toBe("active");
  });

  it("portal mutation: a stale cached updated event cannot undo a newer cancel_at_period_end toggle", async () => {
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: true, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T3
    );
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T2
    );

    expect(db._tables.subscriptions[0].cancel_at_period_end).toBe(true);
  });

  it("forward order still applies every write (the guard never blocks a genuinely newer event)", async () => {
    const db = makeFakeSupabase(seedAccount({}));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T1
    );
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "past_due", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      T2
    );
    await handleSubscriptionDeleted(db, { id: "sub_123" }, {}, T3);

    expect(db._tables.subscriptions[0].status).toBe("canceled");
  });
});

// F-31/C-04: a subscription reporting a base price this deployment doesn't
// sell must not have its status/period/seats synced — no entitlement is
// granted or extended off data this deployment cannot vouch for.
describe("price allowlist (F-31/C-04)", () => {
  const envWithAllowlist = { STRIPE_PRICE_ID: "price_base_v2" };

  it("refuses to sync when the base item's price is not in the allowlist", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_unknown" }, quantity: 1 }] },
      },
      undefined,
      envWithAllowlist
    );

    expect(db._tables.subscriptions[0].status).toBe("incomplete");
  });

  it("syncs normally when the base item's price matches the allowlist", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_base_v2" }, quantity: 1 }] },
      },
      undefined,
      envWithAllowlist
    );

    expect(db._tables.subscriptions[0]).toMatchObject({ status: "active", stripe_price_id: "price_base_v2" });
  });

  it("accepts a price on the legacy allowlist", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_old_v1" }, quantity: 1 }] },
      },
      undefined,
      { STRIPE_PRICE_ID: "price_base_v2", STRIPE_PRICE_ID_LEGACY: "price_old_v1,price_old_v0" }
    );

    expect(db._tables.subscriptions[0].status).toBe("active");
  });

  it("does not distinguish the seat-pack item from the base item as unknown", async () => {
    // The seat-pack item's own price id must never be mistaken for the base
    // item and rejected.
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: {
          data: [
            { id: "si_base", price: { id: "price_base_v2" }, quantity: 1 },
            { id: "si_seat", price: { id: "price_seat" }, quantity: 2 },
          ],
        },
      },
      "price_seat",
      envWithAllowlist
    );

    expect(db._tables.subscriptions[0].status).toBe("active");
    expect(db._tables.subscriptions[0].extra_seats).toBe(6);
  });

  it("allows the write through when no allowlist is configured (fails open, not closed)", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));

    await handleSubscriptionUpdated(
      db,
      {
        id: "sub_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: PERIOD_END_UNIX,
        items: { data: [{ id: "si_base", price: { id: "price_anything" }, quantity: 1 }] },
      },
      undefined,
      {}
    );

    expect(db._tables.subscriptions[0].status).toBe("active");
  });
});

describe("F-40: past_due grace stamping (customer.subscription.updated)", () => {
  it("stamps past_due_since on the transition INTO past_due", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "active" }));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "past_due", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      "2030-01-01T00:00:00.000Z"
    );

    expect(db._tables.subscriptions[0].status).toBe("past_due");
    expect(db._tables.subscriptions[0].past_due_since).toBe("2030-01-01T00:00:00.000Z");
  });

  it("does not restart the grace clock on a repeat past_due event (e.g. a pack purchase mid-dunning)", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "active" }));

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "past_due", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      "2030-01-01T00:00:00.000Z"
    );
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "past_due", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      "2030-01-05T00:00:00.000Z"
    );

    expect(db._tables.subscriptions[0].past_due_since).toBe("2030-01-01T00:00:00.000Z");
  });

  it("clears past_due_since when the subscription recovers to active", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "past_due" }));
    db._tables.subscriptions[0].past_due_since = "2030-01-01T00:00:00.000Z";

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {},
      "2030-01-10T00:00:00.000Z"
    );

    expect(db._tables.subscriptions[0].status).toBe("active");
    expect(db._tables.subscriptions[0].past_due_since).toBeNull();
  });

  it("handleInvoicePaid also clears past_due_since on a recovery payment", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "past_due", provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }));
    db._tables.subscriptions[0].past_due_since = "2030-01-01T00:00:00.000Z";

    await handleInvoicePaid(db, invoice({ billingReason: "subscription_cycle" }));

    expect(db._tables.subscriptions[0].status).toBe("active");
    expect(db._tables.subscriptions[0].past_due_since).toBeNull();
  });
});

describe("F-40: past_due bounded entitlement (accounts.js getLiveSubscription/getEffectiveEntitlement)", () => {
  it("a past_due subscription within the grace window keeps pushing a renewed expiry on recovery-style period advance", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({ status: "past_due", provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
    });
    db._tables.subscriptions[0].current_period_end = "2029-12-01T00:00:00.000Z";
    db._tables.subscriptions[0].past_due_since = new Date().toISOString(); // just went past_due

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {}
    );

    const jobs = jobsOf(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: "SET_EXPIRY",
      payload: { vpn_user_id: "vpn-1", expires_at: NODE_EXPIRY_ISO },
    });
  });

  it("does not extend entitlement for a subscription that has been past_due beyond the grace window (F-40)", async () => {
    // getEffectiveEntitlement (via getLiveSubscription) must not treat this
    // row as live at all once it is outside the grace window: no
    // subscription entitlement, so a renewal-shaped event finds nothing to
    // push (falls through to the disable path only if there's no other
    // source of entitlement — here it also has no admin grant).
    const { getEffectiveEntitlement } = await import("../accounts.js");
    const db = makeFakeSupabase({
      ...seedAccount({ status: "past_due", provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
    });
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago
    db._tables.subscriptions[0].past_due_since = longAgo;

    const entitlement = await getEffectiveEntitlement(db, "acct-1");
    expect(entitlement).toBeNull();
  });

  it("env.PAST_DUE_GRACE_MS shortens the window for getEffectiveEntitlement", async () => {
    const { getEffectiveEntitlement } = await import("../accounts.js");
    const db = makeFakeSupabase({
      ...seedAccount({ status: "past_due" }),
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db._tables.subscriptions[0].past_due_since = twoDaysAgo;

    // Default 14-day grace: still live.
    expect(await getEffectiveEntitlement(db, "acct-1")).not.toBeNull();
    // A 1-day override: no longer live.
    const cut = await getEffectiveEntitlement(db, "acct-1", { PAST_DUE_GRACE_MS: 24 * 60 * 60 * 1000 });
    expect(cut).toBeNull();
  });

  it("a legacy past_due row with no past_due_since stays live (fails open, not closed)", async () => {
    const { getEffectiveEntitlement } = await import("../accounts.js");
    const db = makeFakeSupabase({
      ...seedAccount({ status: "past_due" }),
    });
    db._tables.subscriptions[0].past_due_since = null;

    expect(await getEffectiveEntitlement(db, "acct-1")).not.toBeNull();
  });
});

describe("F-19 remaining gap coverage", () => {
  it("duplicate customer.subscription.updated delivery never double-extends node expiry", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
      subscriptions: [
        {
          id: 1,
          account_id: "acct-1",
          stripe_subscription_id: "sub_123",
          status: "active",
          current_period_end: "2029-12-01T00:00:00.000Z",
          extra_seats: 0,
        },
      ],
    });
    const payload = {
      id: "sub_123",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: PERIOD_END_UNIX,
    };

    await handleSubscriptionUpdated(db, payload, undefined, {}, "2030-01-01T00:00:00.000Z");
    // The exact same event redelivered (same or even later creation time —
    // this is the "duplicate", not the "stale/reordered" case).
    await handleSubscriptionUpdated(db, payload, undefined, {}, "2030-01-01T00:00:00.000Z");

    const setExpiryJobs = jobsOf(db).filter((j) => j.job_type === "SET_EXPIRY");
    expect(setExpiryJobs).toHaveLength(1);
  });

  it("payment recovery via customer.subscription.updated (past_due -> active) pushes a renewed node expiry", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({ status: "past_due", provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
      subscriptions: [
        {
          id: 1,
          account_id: "acct-1",
          stripe_subscription_id: "sub_123",
          status: "past_due",
          current_period_end: "2029-12-01T00:00:00.000Z",
          extra_seats: 0,
          past_due_since: new Date().toISOString(),
        },
      ],
    });

    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {}
    );

    expect(db._tables.subscriptions[0].status).toBe("active");
    const jobs = jobsOf(db).filter((j) => j.job_type === "SET_EXPIRY");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.expires_at).toBe(NODE_EXPIRY_ISO);
  });

  it("cancel_at_period_end=true never triggers an incorrect grace extension by itself (only a genuine period advance does)", async () => {
    const db = makeFakeSupabase({
      ...seedAccount({ provisioned: [{ userId: "user-1", vpnUserId: "vpn-1" }] }),
      subscriptions: [
        {
          id: 1,
          account_id: "acct-1",
          stripe_subscription_id: "sub_123",
          status: "active",
          current_period_end: PERIOD_END_ISO,
          extra_seats: 0,
        },
      ],
    });

    // Customer opts to cancel at period end — same period, cancel flag
    // flips. No push, no grace extension.
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "active", cancel_at_period_end: true, current_period_end: PERIOD_END_UNIX },
      undefined,
      {}
    );
    expect(jobsOf(db)).toHaveLength(0);
    expect(db._tables.subscriptions[0].current_period_end).toBe(PERIOD_END_ISO);

    // At the actual period end Stripe fires the terminal transition — cut
    // immediately, no grace, regardless of the cancel_at_period_end flag
    // that preceded it.
    await handleSubscriptionUpdated(
      db,
      { id: "sub_123", status: "canceled", cancel_at_period_end: false, current_period_end: PERIOD_END_UNIX },
      undefined,
      {}
    );
    const disables = jobsOf(db).filter((j) => j.job_type === "DISABLE_USER");
    expect(disables).toHaveLength(1);
  });

  it("F-19: grace never leaks into currentPeriodEnd — only serviceExpiresAt is extended (resolveEffectiveEntitlement)", async () => {
    const { resolveEffectiveEntitlement } = await import("../accounts.js");
    const entitlement = resolveEffectiveEntitlement(
      {
        status: "active",
        current_period_end: PERIOD_END_ISO,
        cancel_at_period_end: false,
        extra_seats: 0,
      },
      []
    );
    expect(entitlement.currentPeriodEnd).toBe(PERIOD_END_ISO);
    expect(entitlement.serviceExpiresAt).toBe(NODE_EXPIRY_ISO);
    expect(entitlement.serviceExpiresAt).not.toBe(entitlement.currentPeriodEnd);
  });
});
