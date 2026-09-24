import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleSubscriptionTrialing,
} from "../stripe-events.js";
import { makeFakeSupabase, seedAccount } from "./fake-supabase.js";

const PERIOD_END_UNIX = 1893456000; // 2030-01-01T00:00:00Z
const PERIOD_END_ISO = new Date(PERIOD_END_UNIX * 1000).toISOString();

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
      payload: { user_id: "user-1", device_id: device.id, expires_at: PERIOD_END_ISO },
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
    expect(jobs.every((j) => j.payload.expires_at === PERIOD_END_ISO)).toBe(true);
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
      payload: { user_id: "user-1", device_id: device.id, expires_at: TRIAL_END_ISO },
    });
    expect(db._tables.subscriptions[0]).toMatchObject({
      status: "trialing",
      current_period_end: TRIAL_END_ISO,
    });
  });

  it("expires access at the trial end, not at some later date", async () => {
    const db = makeFakeSupabase(seedAccount({ status: "incomplete" }));
    await handleSubscriptionTrialing(db, trialing());
    expect(jobsOf(db)[0].payload.expires_at).toBe(TRIAL_END_ISO);
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
      payload: { vpn_user_id: "vpn-1", expires_at: PERIOD_END_ISO },
    });
  });
});
