import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const stripe = {
  subscriptions: {
    retrieve: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
  },
};
vi.mock("stripe", () => {
  function Stripe() {
    return stripe;
  }
  Stripe.createFetchHttpClient = () => ({});
  return { default: Stripe };
});

const {
  getOverview,
  setExtraPacks,
  moveDevice,
  renameSubscription,
  removeDevice,
  ensureSessionDevice,
  requestAccountDeletion,
} = await import("../account-service.js");
const { makeFakeSupabase } = await import("./fake-supabase.js");

const END = "2030-01-01T00:00:00.000Z";
const user = { id: "user-1", email: "me@example.com" };
const env = { STRIPE_SEAT_PRICE_ID: "price_pack", SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "k" };
const uuid = (n) => `00000000-0000-4000-8000-00000000000${n}`;

function db({ devices = [], subscriptions } = {}) {
  const fake = makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }],
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    subscriptions: subscriptions ?? [
      { id: 1, account_id: "acct-1", name: "Personal", stripe_subscription_id: "sub_p", status: "active", current_period_end: END, extra_seats: 0, created_at: "2026-01-01" },
      { id: 2, account_id: "acct-1", name: "Family", stripe_subscription_id: "sub_f", status: "active", current_period_end: END, extra_seats: 0, created_at: "2026-01-02" },
    ],
    devices,
    vpn_accounts: [],
    provisioning_jobs: [],
    admin_entitlements: [],
  });
  fake.auth = { admin: { updateUserById: vi.fn(async () => ({ error: null })) } };
  return fake;
}
const dev = (n, sub, extra = {}) => ({
  id: uuid(n),
  account_id: "acct-1",
  user_id: "user-1",
  name: `Device ${n}`,
  status: "ACTIVE",
  subscription_id: sub,
  created_at: `2026-02-0${n}`,
  ...extra,
});

beforeEach(() => {
  stripe.subscriptions.retrieve.mockReset().mockResolvedValue({ items: { data: [] } });
  stripe.subscriptions.update.mockReset().mockImplementation(async (_id, params) => ({
    items: { data: params.items?.[0]?.quantity ? [{ id: "si_1", price: "price_pack", quantity: params.items[0].quantity }] : [] },
  }));
  stripe.subscriptions.cancel.mockReset().mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe("getOverview", () => {
  it("reports each subscription's capacity and use, and marks this device", async () => {
    const fake = db({ devices: [dev(1, 1, { auth_session_id: "s-1" }), dev(2, 2), dev(3, 2)] });
    const { body } = await getOverview(fake, user, { sessionId: "s-1" });
    expect(body.subscriptions.map((s) => [s.name, s.used, s.capacity])).toEqual([
      ["Personal", 1, 3],
      ["Family", 2, 3],
    ]);
    expect(body.capacity).toEqual({ total: 6, used: 3 });
    expect(body.devices.find((d) => d.current).id).toBe(uuid(1));
  });
});

describe("setExtraPacks", () => {
  it("buys a pack on the chosen subscription only", async () => {
    const fake = db();
    const res = await setExtraPacks(fake, env, user, "2", 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ extraPacks: 1, capacity: 6 });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_f", expect.objectContaining({
      items: [{ price: "price_pack", quantity: 1 }],
    }));
    const rows = fake._tables.subscriptions;
    expect(rows.find((s) => s.id === 2).extra_seats).toBe(3);
    expect(rows.find((s) => s.id === 1).extra_seats).toBe(0);
  });

  it("never drops capacity below the devices using it", async () => {
    const fake = db({
      subscriptions: [{ id: 1, account_id: "acct-1", name: "Personal", stripe_subscription_id: "sub_p", status: "active", current_period_end: END, extra_seats: 3, created_at: "2026-01-01" }],
      devices: [1, 2, 3, 4].map((n) => dev(n, 1)),
    });
    const res = await setExtraPacks(fake, env, user, "1", 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("devices_in_use");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("rejects another account's subscription as not found", async () => {
    const fake = db();
    fake._tables.subscriptions[1].account_id = "acct-other";
    const res = await setExtraPacks(fake, env, user, "2", 1);
    expect(res.status).toBe(404);
  });

  it("rejects fractional or negative packs", async () => {
    expect((await setExtraPacks(db(), env, user, "1", 1.5)).status).toBe(400);
    expect((await setExtraPacks(db(), env, user, "1", -1)).status).toBe(400);
  });
});

describe("moveDevice", () => {
  it("moves a device into a subscription with room", async () => {
    const fake = db({ devices: [dev(1, 1)] });
    const res = await moveDevice(fake, env, user, uuid(1), "2");
    expect(res.status).toBe(200);
    expect(fake._tables.devices[0].subscription_id).toBe(2);
  });

  it("refuses a full subscription", async () => {
    const fake = db({ devices: [dev(1, 1), dev(2, 2), dev(3, 2), dev(4, 2)] });
    const res = await moveDevice(fake, env, user, uuid(1), "2");
    expect(res.status).toBe(409);
    expect(fake._tables.devices[0].subscription_id).toBe(1);
  });
});

describe("renameSubscription", () => {
  it("renames within 1–80 characters", async () => {
    const fake = db();
    expect((await renameSubscription(fake, user, "1", "  Travel ")).status).toBe(200);
    expect(fake._tables.subscriptions[0].name).toBe("Travel");
    expect((await renameSubscription(fake, user, "1", "")).status).toBe(400);
  });
});

describe("removeDevice", () => {
  it("revokes the device", async () => {
    const fake = db({ devices: [dev(1, 1)] });
    const res = await removeDevice(fake, env, user, uuid(1));
    expect(res.status).toBe(200);
    expect(fake._tables.devices[0].status).toBe("REVOKED");
  });
});

describe("ensureSessionDevice", () => {
  it("creates one device per app session, in the first subscription with room", async () => {
    const fake = db({ devices: [dev(1, 1), dev(2, 1), dev(3, 1)] });
    const first = await ensureSessionDevice(fake, env, user, "sess-a", { name: "My phone", platform: "ios" });
    const again = await ensureSessionDevice(fake, env, user, "sess-a");
    expect(again.id).toBe(first.id);
    const row = fake._tables.devices.find((d) => d.auth_session_id === "sess-a");
    expect(row).toMatchObject({ name: "My phone", platform: "ios", subscription_id: 2 });
  });
});

describe("requestAccountDeletion", () => {
  it("requires the password, then bans sign-in, cancels billing and revokes devices", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 })));
    const fake = db({ devices: [dev(1, 1)] });
    const res = await requestAccountDeletion(fake, env, user, "secret-password");
    expect(res.status).toBe(202);
    expect(fake.auth.admin.updateUserById).toHaveBeenCalledWith("user-1", { ban_duration: "876000h" });
    expect(stripe.subscriptions.cancel.mock.calls.map((c) => c[0]).sort()).toEqual(["sub_f", "sub_p"]);
    expect(fake._tables.devices[0].status).toBe("REVOKED");
    expect(fake._tables.customer_accounts[0].deletion_requested_at).toBeTruthy();
  });

  it("refuses a wrong password without changing anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_code: "invalid_credentials" }), { status: 400 })));
    const fake = db({ devices: [dev(1, 1)] });
    const res = await requestAccountDeletion(fake, env, user, "wrong");
    expect(res.status).toBe(403);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(fake._tables.devices[0].status).toBe("ACTIVE");
  });
});
