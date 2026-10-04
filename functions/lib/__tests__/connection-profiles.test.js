import { describe, it, expect } from "vitest";
import { createProfile, updateProfile, deleteProfile, routingAxes } from "../connection-profiles.js";
import { makeFakeSupabase } from "./fake-supabase.js";

const DE = "11111111-1111-4111-8111-111111111111";
const SE = "22222222-2222-4222-8222-222222222222";
const OFF = "33333333-3333-4333-8333-333333333333";
const user = { id: "user-1" };

function db(extra = {}) {
  return makeFakeSupabase({
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    locations: [
      { id: DE, enabled: true },
      { id: SE, enabled: true },
      { id: OFF, enabled: false },
    ],
    allowed_paths: [
      { id: "p1", entry_location_id: null, exit_location_id: DE, enabled: true },
      { id: "p2", entry_location_id: SE, exit_location_id: DE, enabled: true },
    ],
    connection_profiles: [],
    device_profile_assignments: [],
    ...extra,
  });
}

describe("connection configurations", () => {
  it("creates Automatic, 1-server and 2-server configurations", async () => {
    const fake = db();
    expect((await createProfile(fake, {}, user, { name: "Everyday", routingMode: "AUTO" })).status).toBe(201);
    expect((await createProfile(fake, {}, user, { name: "Germany", routingMode: "DIRECT", exitLocationId: DE })).status).toBe(201);
    expect(
      (await createProfile(fake, {}, user, { name: "Private route", routingMode: "DOUBLE_HOP", entryLocationId: SE, exitLocationId: DE })).status
    ).toBe(201);
    const rows = fake._tables.connection_profiles;
    expect(rows.map((r) => [r.name, r.routing_mode, r.preferred_entry_location_id, r.preferred_exit_location_id])).toEqual([
      ["Everyday", "AUTO", null, null],
      ["Germany", "DIRECT", null, DE],
      ["Private route", "DOUBLE_HOP", SE, DE],
    ]);
    expect(rows.every((r) => r.account_id === "acct-1")).toBe(true);
  });

  it("refuses disabled locations, routes that are not offered and same entry/exit", async () => {
    const fake = db();
    expect((await createProfile(fake, {}, user, { name: "x", routingMode: "DIRECT", exitLocationId: OFF })).status).toBe(400);
    expect((await createProfile(fake, {}, user, { name: "x", routingMode: "DIRECT", exitLocationId: SE })).status).toBe(400);
    expect((await createProfile(fake, {}, user, { name: "x", routingMode: "DOUBLE_HOP", entryLocationId: DE, exitLocationId: DE })).status).toBe(400);
    expect((await createProfile(fake, {}, user, { name: "", routingMode: "AUTO" })).status).toBe(400);
    expect(fake._tables.connection_profiles).toHaveLength(0);
  });

  it("cannot touch another account's configuration", async () => {
    const fake = db({ connection_profiles: [{ id: DE.replace("1111", "9999"), account_id: "acct-2", name: "theirs" }] });
    const id = fake._tables.connection_profiles[0].id;
    expect((await updateProfile(fake, {}, user, id, { name: "mine", routingMode: "AUTO" })).status).toBe(404);
    expect((await deleteProfile(fake, {}, user, id)).status).toBe(404);
    expect(fake._tables.connection_profiles).toHaveLength(1);
  });

  it("deleting unassigns its devices, which fall back to Automatic", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const fake = db({
      connection_profiles: [{ id, account_id: "acct-1", name: "Germany" }],
      device_profile_assignments: [{ device_id: "d1", profile_id: id }],
      subscriptions: [],
      devices: [],
      admin_entitlements: [],
    });
    expect((await deleteProfile(fake, {}, user, id)).status).toBe(200);
    expect(fake._tables.device_profile_assignments).toHaveLength(0);
    expect(fake._tables.connection_profiles).toHaveLength(0);
  });
});

// AUTO and DIRECT are both one hop -- AUTO just also lets the scheduler
// pick the location. See docs/contracts/ARCANA_PRODUCT_V1.md §4/§10: this
// derives the two-axis read model (hop count, who picks the location) that
// the one-column AUTO|DIRECT|DOUBLE_HOP value conflates, reusing
// tamara-next's already-shipped fast/privacy_plus wire vocabulary for the
// hop-count axis rather than the plan's unimplemented ONE_SERVER/TWO_SERVER.
describe("routingAxes", () => {
  it("collapses AUTO and DIRECT onto the same one-hop wire mode", () => {
    expect(routingAxes("AUTO")).toEqual({ hopMode: "fast", locationMode: "AUTO" });
    expect(routingAxes("DIRECT")).toEqual({ hopMode: "fast", locationMode: "PINNED" });
  });

  it("maps DOUBLE_HOP to the two-hop wire mode, location always pinned", () => {
    expect(routingAxes("DOUBLE_HOP")).toEqual({ hopMode: "privacy_plus", locationMode: "PINNED" });
  });
});
