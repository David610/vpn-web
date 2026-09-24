import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveDeviceEntitlements,
  pickSubscriptionWithRoom,
  subscriptionView,
} from "../subscriptions.js";
import { handleSubscriptionDeleted } from "../stripe-events.js";
import { makeFakeSupabase } from "./fake-supabase.js";

const END = "2030-01-01T00:00:00.000Z";
const sub = (id, extra = 0, status = "active") => ({
  id,
  name: `Sub ${id}`,
  status,
  current_period_end: END,
  extra_seats: extra,
  created_at: `2026-01-0${id}T00:00:00Z`,
});
const device = (id, subscriptionId, created, status = "ACTIVE") => ({
  id,
  subscription_id: subscriptionId,
  status,
  created_at: `2026-02-${String(created).padStart(2, "0")}T00:00:00Z`,
});

afterEach(() => vi.restoreAllMocks());

describe("resolveDeviceEntitlements", () => {
  it("serves at most 3 devices per subscription, oldest first", () => {
    const devices = [1, 2, 3, 4].map((n) => device(`d${n}`, 1, n));
    const map = resolveDeviceEntitlements([sub(1)], [], devices);
    expect(["d1", "d2", "d3"].every((id) => map.get(id))).toBe(true);
    expect(map.get("d4")).toBeNull();
  });

  it("each pack adds 3 devices", () => {
    const devices = [1, 2, 3, 4, 5, 6, 7].map((n) => device(`d${n}`, 1, n));
    const map = resolveDeviceEntitlements([sub(1, 3)], [], devices);
    expect(devices.filter((d) => map.get(d.id)).length).toBe(6);
    expect(map.get("d7")).toBeNull();
  });

  it("a device follows its own subscription, not the account", () => {
    const map = resolveDeviceEntitlements(
      [sub(1, 0, "canceled"), sub(2)],
      [],
      [device("a", 1, 1), device("b", 2, 2)]
    );
    expect(map.get("a")).toBeNull();
    expect(map.get("b")).toMatchObject({ currentPeriodEnd: END });
  });

  it("revoked devices neither count nor get served", () => {
    const devices = [
      device("gone", 1, 1, "REVOKED"),
      ...[2, 3, 4].map((n) => device(`d${n}`, 1, n)),
    ];
    const map = resolveDeviceEntitlements([sub(1)], [], devices);
    expect(map.get("gone")).toBeNull();
    expect(["d2", "d3", "d4"].every((id) => map.get(id))).toBe(true);
  });

  it("support grants cover unassigned devices only", () => {
    const grant = { id: "g", starts_at: "2026-01-01", expires_at: null, seat_limit: 3 };
    const map = resolveDeviceEntitlements([], [grant], [device("x", null, 1)]);
    expect(map.get("x")).toMatchObject({ source: "admin_grant", clearExpiry: true });
  });
});

describe("pickSubscriptionWithRoom", () => {
  it("picks the oldest live subscription with a free place", () => {
    const full = [1, 2, 3].map((n) => device(`d${n}`, 1, n));
    expect(pickSubscriptionWithRoom([sub(1), sub(2)], full).id).toBe(2);
    expect(pickSubscriptionWithRoom([sub(1)], full)).toBeNull();
  });
});

describe("subscriptionView", () => {
  it("reports packs, capacity and use", () => {
    const view = subscriptionView(sub(1, 3), [device("a", 1, 1), device("b", 2, 2)]);
    expect(view).toMatchObject({ id: "1", extraPacks: 1, capacity: 6, used: 1 });
  });
});

describe("one subscription ending", () => {
  it("disables only the devices on that subscription", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeSupabase({
      customer_accounts: [{ id: "acct-1" }],
      account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
      subscriptions: [
        { id: 1, account_id: "acct-1", stripe_subscription_id: "sub_personal", status: "active", current_period_end: END, created_at: "2026-01-01" },
        { id: 2, account_id: "acct-1", stripe_subscription_id: "sub_family", status: "active", current_period_end: END, created_at: "2026-01-02" },
      ],
      devices: [
        { id: "phone", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", subscription_id: 1, created_at: "2026-02-01" },
        { id: "tablet", account_id: "acct-1", user_id: "user-1", status: "ACTIVE", subscription_id: 2, created_at: "2026-02-02" },
      ],
      vpn_accounts: [
        { id: 1, user_id: "user-1", device_id: "phone", vpn_user_id: "vpn-phone", node_id: "node-1", enabled: true },
        { id: 2, user_id: "user-1", device_id: "tablet", vpn_user_id: "vpn-tablet", node_id: "node-1", enabled: true },
      ],
      provisioning_jobs: [],
    });

    await handleSubscriptionDeleted(db, { id: "sub_family" });

    const jobs = db._tables.provisioning_jobs;
    const disables = jobs.filter((j) => j.job_type === "DISABLE_USER");
    expect(disables.map((j) => j.payload.vpn_user_id)).toEqual(["vpn-tablet"]);
    expect(jobs.some((j) => j.job_type === "DISABLE_USER" && j.device_id === "phone")).toBe(false);
  });
});
