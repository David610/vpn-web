import { describe, expect, it } from "vitest";
import { assignDeviceProfile } from "../device-assignment.js";
import { makeFakeSupabase } from "./fake-supabase.js";

const END = "2030-01-01T00:00:00.000Z";

function seededWorld() {
  const devices = [1, 2, 3, 4].map((n) => ({
    id: `dev-${n}`,
    account_id: "acct-1",
    user_id: "user-1",
    status: "ACTIVE",
    subscription_id: "sub-1",
    created_at: `2026-02-0${n}T00:00:00Z`,
  }));
  return makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }],
    account_members: [
      { account_id: "acct-1", user_id: "user-1", role: "owner" },
    ],
    subscriptions: [{
      id: "sub-1",
      account_id: "acct-1",
      status: "active",
      current_period_end: END,
      extra_seats: 0,
      created_at: "2026-01-01T00:00:00Z",
    }],
    devices,
    connection_profiles: [{
      id: "profile-1",
      account_id: "acct-1",
      enabled: true,
      routing_mode: "DIRECT",
    }],
    vpn_accounts: [{
      id: 44,
      user_id: "user-1",
      device_id: "dev-4",
      node_id: "node-1",
      vpn_user_id: "vpn-fourth",
      enabled: true,
    }],
    provisioning_jobs: [],
  });
}

describe("assignDeviceProfile per-device entitlement", () => {
  it("never provisions a fourth device outside its own subscription capacity", async () => {
    const db = seededWorld();

    const result = await assignDeviceProfile(
      db,
      {},
      { id: "user-1" },
      "dev-4",
      "profile-1"
    );

    expect(result.status).toBe(200);
    expect(result.body.placement).toEqual({ status: "NOT_ENTITLED" });
    expect(
      db._tables.provisioning_jobs.some((job) => job.job_type === "CREATE_USER")
    ).toBe(false);
    expect(db._tables.provisioning_jobs).toEqual([
      expect.objectContaining({
        job_type: "DISABLE_USER",
        vpn_account_id: 44,
        device_id: "dev-4",
      }),
    ]);
  });

  it("keeps one deterministic assignment idempotency prefix across retries", async () => {
    const db = seededWorld();
    await assignDeviceProfile(db, {}, { id: "user-1" }, "dev-4", "profile-1");
    await assignDeviceProfile(db, {}, { id: "user-1" }, "dev-4", "profile-1");

    expect(
      db._tables.provisioning_jobs.filter((job) => job.job_type === "DISABLE_USER")
    ).toHaveLength(1);
  });
});
