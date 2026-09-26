import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { authorizeRoute, AUTHORIZE_TTL_MS } from "../vpn-authorize.js";
import { loadRouteInputs, renderRoutes } from "../route-directory.js";

const DEVICE = { id: "dev-1", user_id: "user-1", account_id: "acct-1" };
const PAID = { source: "stripe", serviceExpiresAt: "2030-01-01T00:00:00.000Z", clearExpiry: false };

const DE = "loc-de";
const FI = "loc-fi";

let ipCounter = 10;
function node(node_id, location_id, role, extra = {}) {
  ipCounter += 1;
  return {
    node_id,
    location_id,
    role,
    lifecycle_state: "READY",
    configured_users: 0,
    max_sessions: null,
    ip_address: `203.0.113.${ipCounter}`,
    failure_domain: `fd/${node_id}`,
    transport: "vless-reality",
    transport_port: 443,
    tls_server_name: "decoy.example.test",
    reality_public_key: `pub-${node_id}`,
    reality_short_id: "abcd",
    reality_fingerprint: "chrome",
    vless_flow: "xtls-rprx-vision",
    ...extra,
  };
}

const LOCATIONS = [
  { id: DE, country_code: "DE", display_name: "Germany", enabled: true },
  { id: FI, country_code: "FI", display_name: "Finland", enabled: true },
];

function world({ locations = LOCATIONS, nodes = [], paths = [], identities = [], assignments = [] } = {}) {
  return makeFakeSupabase({
    locations,
    nodes,
    allowed_paths: paths,
    device_node_assignments: assignments,
    vpn_accounts: identities.map((i, n) => ({ id: n + 1, device_id: DEVICE.id, enabled: true, ...i })),
  });
}

const jobs = (db) => db._tables.provisioning_jobs ?? [];
const directPath = (loc) => ({ id: `p-${loc}`, entry_location_id: null, exit_location_id: loc, enabled: true });
const doublePath = (entry, exit) => ({ id: `p-${entry}-${exit}`, entry_location_id: entry, exit_location_id: exit, enabled: true });

// What a client actually holds: the directory rendered from the same fleet state.
async function directory(db) {
  return renderRoutes(await loadRouteInputs(db)).routes;
}

const authorize = (db, routeId, entitlement = PAID) =>
  authorizeRoute(db, {}, { device: DEVICE, entitlement, routeId });

describe("authorizeRoute: route_id validation", () => {
  it("rejects an empty route_id", async () => {
    const result = await authorize(world(), "");
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });

  it("rejects a route_id over 160 characters", async () => {
    const result = await authorize(world(), "a".repeat(161));
    expect(result.status).toBe(400);
  });

  it("treats legacy location-level ids as stale (client must refresh), never reschedules", async () => {
    const db = world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)] });
    const result = await authorize(db, "de-fast");
    expect(result).toMatchObject({ ok: false, status: 409, code: "route_stale" });
    expect(jobs(db)).toHaveLength(0);
  });
});

describe("authorizeRoute: exact physical-hop binding", () => {
  it("REGRESSION: a sticky assignment to node B never overrides the signed candidate for node A", async () => {
    // B is less loaded than A would be for this device, and the device is
    // sticky on B. The old implementation published one location-level
    // route (whichever node the scheduler preferred with no stickiness)
    // and then re-ran the sticky scheduler at authorize time.
    const a = node("de-a", DE, "EXIT", { configured_users: 0 });
    const b = node("de-b", DE, "EXIT", { configured_users: 5 });
    const db = world({
      nodes: [a, b],
      paths: [directPath(DE)],
      assignments: [{ device_id: DEVICE.id, node_id: "de-b", hop: "EXIT" }],
      identities: [
        { node_id: "de-a", vpn_user_id: "uuid-on-a" },
        { node_id: "de-b", vpn_user_id: "uuid-on-b" },
      ],
    });
    const routes = await directory(db);
    const routeForA = routes.find((r) => r.hops[0].server_address === a.ip_address);
    const routeForB = routes.find((r) => r.hops[0].server_address === b.ip_address);
    expect(routeForA).toBeDefined();
    expect(routeForB).toBeDefined();

    const resultA = await authorize(db, routeForA.id);
    expect(resultA.ok).toBe(true);
    expect(resultA.credentialEnvelope.hops).toEqual([{ uuid: "uuid-on-a" }]);

    const resultB = await authorize(db, routeForB.id);
    expect(resultB.credentialEnvelope.hops).toEqual([{ uuid: "uuid-on-b" }]);
  });

  it("every published candidate authorizes exactly its own hop set (fast + privacy_plus)", async () => {
    const nodes = [
      node("de-e1", DE, "EXIT"),
      node("de-e2", DE, "EXIT", { configured_users: 3 }),
      node("fi-r1", FI, "RELAY"),
      node("fi-r2", FI, "RELAY", { configured_users: 7 }),
    ];
    const byIp = new Map(nodes.map((n) => [n.ip_address, n.node_id]));
    const db = world({
      nodes,
      paths: [directPath(DE), doublePath(FI, DE)],
      identities: nodes.map((n) => ({ node_id: n.node_id, vpn_user_id: `uuid-${n.node_id}` })),
      assignments: [
        { device_id: DEVICE.id, node_id: "de-e2", hop: "EXIT" },
        { device_id: DEVICE.id, node_id: "fi-r2", hop: "RELAY" },
      ],
    });
    const routes = await directory(db);
    expect(routes.filter((r) => r.mode === "fast")).toHaveLength(2);
    expect(routes.filter((r) => r.mode === "privacy_plus").length).toBeGreaterThanOrEqual(2);
    for (const route of routes) {
      const result = await authorize(db, route.id);
      expect(result.ok).toBe(true);
      const expected = route.hops.map((hop) => ({ uuid: `uuid-${byIp.get(hop.server_address)}` }));
      expect(result.credentialEnvelope.hops).toEqual(expected);
    }
  });

  it("records the resolved hops as the device's assignment (after resolving, never to choose)", async () => {
    const db = world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [directPath(DE), doublePath(FI, DE)],
      identities: [
        { node_id: "de-e1", vpn_user_id: "u1" },
        { node_id: "fi-r1", vpn_user_id: "u2" },
      ],
    });
    const routes = await directory(db);
    await authorize(db, routes.find((r) => r.mode === "privacy_plus").id);
    const rows = () => db._tables.device_node_assignments.map((r) => `${r.hop}:${r.node_id}`).sort();
    expect(rows()).toEqual(["EXIT:de-e1", "RELAY:fi-r1"]);
    await authorize(db, routes.find((r) => r.mode === "fast").id);
    expect(rows()).toEqual(["EXIT:de-e1"]);
  });

  it("fails closed with route_stale when the node's published metadata changed after the directory was fetched", async () => {
    const db = world({ nodes: [node("de-a", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-a", vpn_user_id: "u" }] });
    const [route] = await directory(db);
    db._tables.nodes[0].reality_public_key = "rotated-key";
    const result = await authorize(db, route.id);
    expect(result).toMatchObject({ ok: false, status: 409, code: "route_stale" });
  });

  it("fails closed with route_stale (does not move to a sibling) when the chosen node is drained", async () => {
    const db = world({
      nodes: [node("de-a", DE, "EXIT"), node("de-b", DE, "EXIT", { configured_users: 4 })],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-a", vpn_user_id: "ua" },
        { node_id: "de-b", vpn_user_id: "ub" },
      ],
    });
    const routes = await directory(db);
    const routeForA = routes.find((r) => r.priority === 100);
    db._tables.nodes.find((n) => n.node_id === "de-a").lifecycle_state = "DRAINING";
    const result = await authorize(db, routeForA.id);
    expect(result).toMatchObject({ ok: false, status: 409, code: "route_stale" });
  });

  it("a published route stays authorizable after load shifts push it out of the published top-N", async () => {
    const db = world({
      nodes: ["a", "b", "c", "d"].map((x, i) => node(`de-${x}`, DE, "EXIT", { configured_users: i })),
      paths: [directPath(DE)],
      identities: ["a", "b", "c", "d"].map((x) => ({ node_id: `de-${x}`, vpn_user_id: `u-${x}` })),
    });
    const routes = await directory(db);
    const third = routes.find((r) => r.priority === 80);
    expect(third).toBeDefined();
    // Load shift: de-d becomes least loaded; de-c is no longer in the published top 3.
    db._tables.nodes.find((n) => n.node_id === "de-d").configured_users = 0;
    db._tables.nodes.find((n) => n.node_id === "de-c").configured_users = 9;
    const now = await directory(db);
    expect(now.map((r) => r.id)).not.toContain(third.id);
    const result = await authorize(db, third.id);
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope.hops).toEqual([{ uuid: "u-c" }]);
  });

  it("a device already assigned to a now-full node can still authorize that exact node", async () => {
    const db = world({
      nodes: [node("de-a", DE, "EXIT", { configured_users: 1, max_sessions: 2 })],
      paths: [directPath(DE)],
      assignments: [{ device_id: DEVICE.id, node_id: "de-a", hop: "EXIT" }],
      identities: [{ node_id: "de-a", vpn_user_id: "ua" }],
    });
    const [route] = await directory(db);
    db._tables.nodes[0].configured_users = 2;
    expect((await authorize(db, route.id)).ok).toBe(true);
    // A device that holds no slot there is rejected with route_stale.
    const other = await authorizeRoute(db, {}, { device: { ...DEVICE, id: "dev-2" }, entitlement: PAID, routeId: route.id });
    expect(other).toMatchObject({ ok: false, status: 409, code: "route_stale" });
  });

  it("fails closed when the allowed path is disabled after the directory was fetched", async () => {
    const db = world({ nodes: [node("de-a", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-a", vpn_user_id: "u" }] });
    const [route] = await directory(db);
    db._tables.allowed_paths[0].enabled = false;
    expect((await authorize(db, route.id)).code).toBe("route_stale");
  });

  it("privacy_plus: if the relay disappears, the route is stale -- never a one-hop (Fast) envelope", async () => {
    const db = world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [directPath(DE), doublePath(FI, DE)],
      identities: [
        { node_id: "de-e1", vpn_user_id: "u1" },
        { node_id: "fi-r1", vpn_user_id: "u2" },
      ],
    });
    const privacy = (await directory(db)).find((r) => r.mode === "privacy_plus");
    db._tables.nodes.find((n) => n.node_id === "fi-r1").lifecycle_state = "FAILED";
    const result = await authorize(db, privacy.id);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("route_stale");
  });
});

describe("authorizeRoute: credential resolution", () => {
  it("returns a single-hop envelope with a short expires_at", async () => {
    const db = world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-1", vpn_user_id: "uuid-de-1" }] });
    const [route] = await directory(db);
    const before = Date.now();
    const result = await authorize(db, route.id);
    expect(result.routeId).toBe(route.id);
    expect(result.credentialEnvelope).toEqual({ version: 1, hops: [{ uuid: "uuid-de-1" }] });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(before + AUTHORIZE_TTL_MS);
  });

  it("enqueues CREATE_USER for every missing hop and returns 503, never a partial envelope", async () => {
    const db = world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [doublePath(FI, DE)],
      identities: [{ node_id: "de-e1", vpn_user_id: "u1" }],
    });
    const [route] = await directory(db);
    const result = await authorize(db, route.id);
    expect(result).toEqual({ ok: false, status: 503, message: expect.any(String) });
    expect(jobs(db).map((j) => j.node_id)).toEqual(["fi-r1"]);
  });

  it("propagates the finite-entitlement-missing-expiry error rather than returning 503", async () => {
    const db = world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)] });
    const [route] = await directory(db);
    await expect(authorize(db, route.id, { clearExpiry: false, serviceExpiresAt: null })).rejects.toThrow(
      "finite entitlement is missing serviceExpiresAt"
    );
  });
});
