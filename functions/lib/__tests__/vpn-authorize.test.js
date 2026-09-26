import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { authorizeRoute, AUTHORIZE_TTL_MS } from "../vpn-authorize.js";

const DEVICE = { id: "dev-1", user_id: "user-1", account_id: "acct-1" };
const PAID = { source: "stripe", serviceExpiresAt: "2030-01-01T00:00:00.000Z", clearExpiry: false };

const DE = "loc-de";
const FI = "loc-fi";

function node(node_id, location_id, role, extra = {}) {
  return { node_id, location_id, role, lifecycle_state: "READY", configured_users: 0, max_sessions: null, ...extra };
}

function world({ locations = [], nodes = [], paths = [], identities = [] } = {}) {
  return makeFakeSupabase({
    locations,
    nodes,
    allowed_paths: paths,
    vpn_accounts: identities.map((i, n) => ({ id: n + 1, device_id: DEVICE.id, enabled: true, ...i })),
  });
}

const jobs = (db) => db._tables.provisioning_jobs;
const directPath = (loc) => ({ id: `p-${loc}`, entry_location_id: null, exit_location_id: loc, enabled: true });
const doublePath = (entry, exit) => ({ id: `p-${entry}-${exit}`, entry_location_id: entry, exit_location_id: exit, enabled: true });

describe("authorizeRoute: route_id validation", () => {
  it("rejects an empty route_id", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "" });
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });

  it("rejects a route_id over 160 characters", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "a".repeat(161) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects an unrecognized route_id format", async () => {
    const db = world();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "not-a-real-route" });
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });
});

describe("authorizeRoute: fast routes", () => {
  it("returns 409 route_not_found when the location does not exist or is disabled", async () => {
    const db = world({ locations: [{ id: DE, country_code: "DE", enabled: false }] });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 409, message: expect.any(String), code: "route_not_found" });
  });

  it("returns 503 when no direct allowed_paths row exists for the location", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
  });

  it("returns a single-hop credential envelope when the identity already exists", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [{ node_id: "node-de-1", vpn_user_id: "uuid-de-1" }],
    });
    const before = Date.now();
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result.ok).toBe(true);
    expect(result.routeId).toBe("de-fast");
    expect(result.credentialEnvelope).toEqual({ version: 1, hops: [{ uuid: "uuid-de-1" }] });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(before + AUTHORIZE_TTL_MS);
    expect(jobs(db)).toHaveLength(0);
  });

  it("enqueues CREATE_USER and returns 503 when no identity exists yet", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
    expect(jobs(db)[0]).toMatchObject({
      job_type: "CREATE_USER",
      node_id: "node-de-1",
      device_id: "dev-1",
      idempotency_key: "authorize:create:dev-1:node-de-1",
      payload: { user_id: "user-1", device_id: "dev-1", expires_at: "2030-01-01T00:00:00.000Z" },
    });
  });

  it("does not error when a CREATE_USER job is already in flight, and still returns 503", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    await db.from("provisioning_jobs").insert({
      idempotency_key: "reconcile:create:dev-1:node-de-1",
      node_id: "node-de-1",
      job_type: "CREATE_USER",
      device_id: "dev-1",
      status: "pending",
      payload: {},
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-fast" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
  });
});

describe("authorizeRoute: privacy_plus routes", () => {
  it("returns a two-hop envelope, relay first, when both identities exist", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
      identities: [
        { node_id: "node-fi-1", vpn_user_id: "uuid-fi-1" },
        { node_id: "node-de-1", vpn_user_id: "uuid-de-1" },
      ],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope).toEqual({
      version: 1,
      hops: [{ uuid: "uuid-fi-1" }, { uuid: "uuid-de-1" }],
    });
  });

  it("enqueues CREATE_USER only for the missing hop when one identity exists", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
      identities: [{ node_id: "node-fi-1", vpn_user_id: "uuid-fi-1" }],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db)).toHaveLength(1);
    expect(jobs(db)[0].node_id).toBe("node-de-1");
  });

  it("enqueues CREATE_USER for both hops when neither identity exists", async () => {
    const db = world({
      locations: [
        { id: FI, country_code: "FI", enabled: true },
        { id: DE, country_code: "DE", enabled: true },
      ],
      nodes: [node("node-fi-1", FI, "RELAY"), node("node-de-1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "fi-de-privacy" });
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db).map((j) => j.node_id).sort()).toEqual(["node-de-1", "node-fi-1"]);
  });

  it("resolves normally when entry and exit locations are the same", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-relay", DE, "RELAY"), node("node-de-exit", DE, "EXIT")],
      paths: [doublePath(DE, DE)],
      identities: [
        { node_id: "node-de-relay", vpn_user_id: "uuid-relay" },
        { node_id: "node-de-exit", vpn_user_id: "uuid-exit" },
      ],
    });
    const result = await authorizeRoute(db, {}, { device: DEVICE, entitlement: PAID, routeId: "de-de-privacy" });
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope.hops).toEqual([{ uuid: "uuid-relay" }, { uuid: "uuid-exit" }]);
  });

  it("propagates the finite-entitlement-missing-expiry error rather than returning 503", async () => {
    const db = world({
      locations: [{ id: DE, country_code: "DE", enabled: true }],
      nodes: [node("node-de-1", DE, "EXIT")],
      paths: [directPath(DE)],
    });
    const brokenEntitlement = { clearExpiry: false, serviceExpiresAt: null };
    await expect(
      authorizeRoute(db, {}, { device: DEVICE, entitlement: brokenEntitlement, routeId: "de-fast" })
    ).rejects.toThrow("finite entitlement is missing serviceExpiresAt");
  });
});
