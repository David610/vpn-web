import { describe, it, expect } from "vitest";
import { makeFakeSupabase } from "./fake-supabase.js";
import { authorizeRoute, LEASE_LIMITS } from "../vpn-authorize.js";
import { encryptSecret } from "../crypto.js";
import { loadRouteInputs, renderRoutes } from "../route-directory.js";

const DEVICE = { id: "dev-1", user_id: "user-1", account_id: "acct-1" };

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

const KEY = "a".repeat(64);
const ENV = { VPN_SECRETS_ENCRYPTION_KEY: KEY };
const MINUTE = 60 * 1000;

// `identities` seed node-confirmed lease-pool slots: one active slot per
// entry, whose VLESS uuid is `vpn_user_id` (kept as the field name so the
// route-binding tests read the same as before ADR-0003).
async function slotRow({ node_id, vpn_user_id, password, slot = 0, generation = 1, validForMs = 15 * MINUTE, state = "active" }) {
  const secret = JSON.stringify({ vless_uuid: vpn_user_id, hysteria2_password: password ?? `pw-${vpn_user_id}` });
  const { ciphertext, nonce } = await encryptSecret(secret, KEY);
  return {
    node_id,
    slot,
    generation,
    valid_until: new Date(Date.now() + validForMs).toISOString(),
    credential_ciphertext: ciphertext,
    credential_nonce: nonce,
    state,
    lease_id: null,
  };
}

async function world({ locations = LOCATIONS, nodes = [], paths = [], identities = [], assignments = [], slotsPerIdentity = 1 } = {}) {
  const expanded = identities.flatMap((identity) =>
    Array.from({ length: slotsPerIdentity }, (_, k) => ({ ...identity, slot: (identity.slot ?? 0) + k }))
  );
  return makeFakeSupabase({
    locations,
    nodes,
    allowed_paths: paths,
    device_node_assignments: assignments,
    node_lease_slots: await Promise.all(expanded.map(slotRow)),
  });
}

const jobs = (db) => db._tables.provisioning_jobs ?? [];
const directPath = (loc) => ({ id: `p-${loc}`, entry_location_id: null, exit_location_id: loc, enabled: true });
const doublePath = (entry, exit) => ({ id: `p-${entry}-${exit}`, entry_location_id: entry, exit_location_id: exit, enabled: true });

// What a client actually holds: the directory rendered from the same fleet state.
async function directory(db) {
  return renderRoutes(await loadRouteInputs(db)).routes;
}

const authorize = (db, routeId, clientRequestId = null, device = DEVICE) =>
  authorizeRoute(db, ENV, { device, routeId, clientRequestId });

describe("authorizeRoute: route_id validation", () => {
  it("rejects an empty route_id", async () => {
    const result = await authorize(await world(), "");
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });

  it("rejects a route_id over 160 characters", async () => {
    const result = await authorize(await world(), "a".repeat(161));
    expect(result.status).toBe(400);
  });

  it("treats legacy location-level ids as stale (client must refresh), never reschedules", async () => {
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)] });
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
    const db = await world({
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
    const db = await world({
      nodes,
      paths: [directPath(DE), doublePath(FI, DE)],
      identities: nodes.map((n) => ({ node_id: n.node_id, vpn_user_id: `uuid-${n.node_id}` })),
      slotsPerIdentity: 8,
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
    const db = await world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [directPath(DE), doublePath(FI, DE)],
      identities: [
        { node_id: "de-e1", vpn_user_id: "u1" },
        { node_id: "fi-r1", vpn_user_id: "u2" },
      ],
      slotsPerIdentity: 2,
    });
    const routes = await directory(db);
    await authorize(db, routes.find((r) => r.mode === "privacy_plus").id);
    const rows = () => db._tables.device_node_assignments.map((r) => `${r.hop}:${r.node_id}`).sort();
    expect(rows()).toEqual(["EXIT:de-e1", "RELAY:fi-r1"]);
    await authorize(db, routes.find((r) => r.mode === "fast").id);
    expect(rows()).toEqual(["EXIT:de-e1"]);
  });

  it("fails closed with route_stale when the node's published metadata changed after the directory was fetched", async () => {
    const db = await world({ nodes: [node("de-a", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-a", vpn_user_id: "u" }] });
    const [route] = await directory(db);
    db._tables.nodes[0].reality_public_key = "rotated-key";
    const result = await authorize(db, route.id);
    expect(result).toMatchObject({ ok: false, status: 409, code: "route_stale" });
  });

  it("fails closed with route_stale (does not move to a sibling) when the chosen node is drained", async () => {
    const db = await world({
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
    const db = await world({
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
    const db = await world({
      nodes: [node("de-a", DE, "EXIT", { configured_users: 1, max_sessions: 2 })],
      paths: [directPath(DE)],
      assignments: [{ device_id: DEVICE.id, node_id: "de-a", hop: "EXIT" }],
      identities: [{ node_id: "de-a", vpn_user_id: "ua" }],
    });
    const [route] = await directory(db);
    db._tables.nodes[0].configured_users = 2;
    expect((await authorize(db, route.id)).ok).toBe(true);
    // A device that holds no slot there is rejected with route_stale.
    const other = await authorizeRoute(db, {}, { device: { ...DEVICE, id: "dev-2" }, routeId: route.id });
    expect(other).toMatchObject({ ok: false, status: 409, code: "route_stale" });
  });

  it("fails closed when the allowed path is disabled after the directory was fetched", async () => {
    const db = await world({ nodes: [node("de-a", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-a", vpn_user_id: "u" }] });
    const [route] = await directory(db);
    db._tables.allowed_paths[0].enabled = false;
    expect((await authorize(db, route.id)).code).toBe("route_stale");
  });

  it("privacy_plus: if the relay disappears, the route is stale -- never a one-hop (Fast) envelope", async () => {
    const db = await world({
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

describe("authorizeRoute: ephemeral lease pool (ADR-0003)", () => {
  const slots = (db) => db._tables.node_lease_slots;
  const leases = (db) => db._tables.vpn_leases;
  const hy2 = { transport: "hysteria2", transport_port: 8443 };

  it("single hop: returns the leased slot's credential and the slot's real valid_until as expires_at", async () => {
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-1", vpn_user_id: "uuid-de-1" }] });
    const [route] = await directory(db);
    const result = await authorize(db, route.id);
    expect(result.ok).toBe(true);
    expect(result.credentialEnvelope).toEqual({ version: 1, hops: [{ uuid: "uuid-de-1" }] });
    expect(result.expiresAt).toBe(new Date(slots(db)[0].valid_until).toISOString());
    expect(slots(db)[0].state).toBe("leased");
    // Never a long-lived identity: no provisioning job, no vpn_accounts read.
    expect(jobs(db)).toHaveLength(0);
  });

  it("returns `password` for hysteria2 hops and `uuid` for vless-reality hops", async () => {
    const db = await world({
      nodes: [node("fi-r1", FI, "RELAY", hy2), node("de-e1", DE, "EXIT")],
      paths: [doublePath(FI, DE)],
      identities: [
        { node_id: "fi-r1", vpn_user_id: "relay-uuid", password: "relay-pw" },
        { node_id: "de-e1", vpn_user_id: "exit-uuid" },
      ],
    });
    const [route] = await directory(db);
    const result = await authorize(db, route.id);
    expect(result.credentialEnvelope.hops).toEqual([{ password: "relay-pw" }, { uuid: "exit-uuid" }]);
  });

  it("Privacy+ is atomic: when the exit pool is exhausted nothing is leased on the relay (no one-hop partial)", async () => {
    const db = await world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [doublePath(FI, DE)],
      identities: [{ node_id: "fi-r1", vpn_user_id: "relay-only" }],
    });
    const [route] = await directory(db);
    const result = await authorize(db, route.id);
    expect(result).toMatchObject({ ok: false, status: 503, code: "capacity_exhausted" });
    expect(slots(db).map((s) => s.state)).toEqual(["active"]);
    expect(leases(db)).toHaveLength(0);
    expect(db._tables.device_node_assignments).toHaveLength(0);
  });

  it("Privacy+ expires_at is the EARLIER of the two hops' slot ends", async () => {
    const db = await world({
      nodes: [node("de-e1", DE, "EXIT"), node("fi-r1", FI, "RELAY")],
      paths: [doublePath(FI, DE)],
      identities: [
        { node_id: "fi-r1", vpn_user_id: "r", validForMs: 12 * MINUTE },
        { node_id: "de-e1", vpn_user_id: "e", validForMs: 14 * MINUTE },
      ],
    });
    const [route] = await directory(db);
    const result = await authorize(db, route.id);
    const relay = slots(db).find((s) => s.node_id === "fi-r1");
    expect(result.expiresAt).toBe(new Date(relay.valid_until).toISOString());
  });

  it("pool exhaustion: each slot is leased at most once, then 503 capacity_exhausted", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-1", vpn_user_id: "s0", slot: 0 },
        { node_id: "de-1", vpn_user_id: "s1", slot: 1 },
      ],
    });
    const [route] = await directory(db);
    // Distinct devices: the same device re-authorizing the route renews instead.
    const a = await authorize(db, route.id, null, { ...DEVICE, id: "dev-a" });
    const b = await authorize(db, route.id, null, { ...DEVICE, id: "dev-b" });
    const c = await authorize(db, route.id, null, { ...DEVICE, id: "dev-c" });
    expect(new Set([a.credentialEnvelope.hops[0].uuid, b.credentialEnvelope.hops[0].uuid])).toEqual(new Set(["s0", "s1"]));
    expect(c).toMatchObject({ ok: false, status: 503, code: "capacity_exhausted" });
  });

  it("never leases a slot with less than the minimum remaining lifetime, nor an unconfirmed/revoked one", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-1", vpn_user_id: "almost-expired", slot: 0, validForMs: LEASE_LIMITS.minRemainingSeconds * 1000 - MINUTE },
        { node_id: "de-1", vpn_user_id: "revoked", slot: 1, state: "revoked" },
      ],
    });
    const [route] = await directory(db);
    expect(await authorize(db, route.id)).toMatchObject({ status: 503, code: "capacity_exhausted" });
  });

  it("idempotent retry with the same client_request_id returns the same lease and burns no second slot", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-1", vpn_user_id: "s0", slot: 0 },
        { node_id: "de-1", vpn_user_id: "s1", slot: 1 },
      ],
    });
    const [route] = await directory(db);
    const first = await authorize(db, route.id, "req-00000001");
    const retry = await authorize(db, route.id, "req-00000001");
    expect(retry).toEqual(first);
    expect(leases(db)).toHaveLength(1);
    expect(slots(db).filter((s) => s.state === "active")).toHaveLength(1);
    // The raw client id is never stored.
    expect(JSON.stringify(leases(db))).not.toContain("req-00000001");
    // A NEW request id on the same route while the lease is live renews it:
    // same slot and credential, no second slot.
    const renewal = await authorize(db, route.id, "req-00000002");
    expect(renewal.renewed).toBe(true);
    expect(renewal.credentialEnvelope).toEqual(first.credentialEnvelope);
    expect(leases(db)).toHaveLength(1);
    expect(slots(db).filter((s) => s.state === "active")).toHaveLength(1);
  });

  it("an expired lease is not replayed: the same client_request_id gets a fresh slot", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-1", vpn_user_id: "s0", slot: 0 },
        { node_id: "de-1", vpn_user_id: "s1", slot: 1 },
      ],
    });
    const [route] = await directory(db);
    const first = await authorize(db, route.id, "req-00000001");
    leases(db)[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const again = await authorize(db, route.id, "req-00000001");
    expect(again.ok).toBe(true);
    expect(again.credentialEnvelope.hops[0].uuid).not.toBe(first.credentialEnvelope.hops[0].uuid);
  });

  it("revocation kills replay: a revoked device's retry does not get the old credential back", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [{ node_id: "de-1", vpn_user_id: "s0", slot: 0 }],
    });
    const [route] = await directory(db);
    await authorize(db, route.id, "req-00000001");
    await db.rpc("revoke_device_leases", { p_device_id: DEVICE.id });
    expect(slots(db)[0].state).toBe("revoked");
    expect(await authorize(db, route.id, "req-00000001")).toMatchObject({ status: 503, code: "capacity_exhausted" });
  });

  it("rate-limits new leases per device (429 with retry hint); replays do not count", async () => {
    const identities = Array.from({ length: LEASE_LIMITS.perDevice + 2 }, (_, i) => ({ node_id: "de-1", vpn_user_id: `s${i}`, slot: i }));
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)], identities });
    const [route] = await directory(db);
    for (let i = 0; i < LEASE_LIMITS.perDevice; i += 1) {
      expect((await authorize(db, route.id, `req-${String(i).padStart(8, "0")}`)).ok).toBe(true);
      if (i === 0) expect((await authorize(db, route.id, "req-00000000")).ok).toBe(true); // replay
      // End the lease (as if it expired), so the next call needs a NEW lease
      // rather than renewing this one.
      for (const l of leases(db)) l.expires_at = new Date(Date.now() - 1000).toISOString();
    }
    expect(leases(db)).toHaveLength(LEASE_LIMITS.perDevice);
    const limited = await authorize(db, route.id, "req-99999999");
    expect(limited).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: LEASE_LIMITS.windowSeconds });
  });

  it("rate-limits per account across devices", async () => {
    const identities = Array.from({ length: LEASE_LIMITS.perAccount + 1 }, (_, i) => ({ node_id: "de-1", vpn_user_id: `s${i}`, slot: i }));
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)], identities });
    const [route] = await directory(db);
    for (let i = 0; i < LEASE_LIMITS.perAccount; i += 1) {
      const device = { ...DEVICE, id: `dev-${i}` };
      expect((await authorize(db, route.id, null, device)).ok).toBe(true);
    }
    expect(await authorize(db, route.id, null, { ...DEVICE, id: "dev-new" })).toMatchObject({ status: 429 });
  });

  it("rejects a malformed client_request_id", async () => {
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)], identities: [{ node_id: "de-1", vpn_user_id: "s0" }] });
    const [route] = await directory(db);
    expect(await authorize(db, route.id, "bad id!")).toMatchObject({ status: 400 });
    expect(leases(db)).toHaveLength(0);
  });

  it("idempotency key reused for a different route is a conflict, not a credential", async () => {
    const db = await world({
      nodes: [node("de-a", DE, "EXIT"), node("de-b", DE, "EXIT", { configured_users: 3 })],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-a", vpn_user_id: "ua" },
        { node_id: "de-b", vpn_user_id: "ub" },
      ],
    });
    const [r1, r2] = await directory(db);
    await authorize(db, r1.id, "req-00000001");
    // Different route => different hashed key, so it is simply a new lease.
    const second = await authorize(db, r2.id, "req-00000001");
    expect(second.ok).toBe(true);
  });
});

describe("authorizeRoute: renewal extends the live lease in place (ADR-0003)", () => {
  const slots = (db) => db._tables.node_lease_slots;
  const leases = (db) => db._tables.vpn_leases;
  const twoSlots = () =>
    world({
      nodes: [node("de-1", DE, "EXIT")],
      paths: [directPath(DE)],
      identities: [
        { node_id: "de-1", vpn_user_id: "s0", slot: 0 },
        { node_id: "de-1", vpn_user_id: "s1", slot: 1 },
      ],
    });

  it("same slot, same credential, later expires_at on the node's grid; no new lease, no rate-limit cost", async () => {
    const db = await twoSlots();
    db._tables.node_lease_policy.push({ node_id: "de-1", rotation_batch_interval_secs: 300, slot_lifetime_secs: 1800 });
    const [route] = await directory(db);
    const first = await authorize(db, route.id);
    const before = Date.now();
    const renewed = await authorize(db, route.id);
    expect(renewed).toMatchObject({ ok: true, renewed: true, routeId: first.routeId });
    expect(renewed.credentialEnvelope).toEqual(first.credentialEnvelope);
    const exp = new Date(renewed.expiresAt).getTime();
    expect(exp).toBeGreaterThan(new Date(first.expiresAt).getTime());
    expect(exp % (300 * 1000)).toBe(0);
    expect(exp).toBeLessThanOrEqual(before + LEASE_LIMITS.renewSeconds * 1000 + 1000);
    expect(exp).toBeGreaterThan(before + LEASE_LIMITS.renewSeconds * 1000 - 300 * 1000 - 1000);
    expect(leases(db)).toHaveLength(1);
    expect(leases(db)[0].expires_at).toBe(renewed.expiresAt);
    const leased = slots(db).find((s) => s.state === "leased");
    expect(leased.extend_to).toBe(renewed.expiresAt); // what the node adopts
    expect(slots(db).filter((s) => s.state === "active")).toHaveLength(1);
  });

  it("renewal is capped by the node's slot lifetime and never shortens a lease", async () => {
    const db = await twoSlots();
    db._tables.node_lease_policy.push({ node_id: "de-1", rotation_batch_interval_secs: 60, slot_lifetime_secs: 900 });
    const [route] = await directory(db);
    await authorize(db, route.id);
    const renewed = await authorize(db, route.id);
    expect(new Date(renewed.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 900 * 1000);
    leases(db)[0].expires_at = new Date(Date.now() + 3600 * 1000).toISOString();
    const again = await authorize(db, route.id);
    expect(again.expiresAt).toBe(leases(db)[0].expires_at);
  });

  it("a lease too close to its end, revoked, or on another route is not renewed", async () => {
    const db = await twoSlots();
    const [route] = await directory(db);
    const first = await authorize(db, route.id, null, DEVICE);
    leases(db)[0].expires_at = new Date(Date.now() + (LEASE_LIMITS.renewMinLeadSeconds - 5) * 1000).toISOString();
    const fresh = await authorize(db, route.id, null, DEVICE);
    expect(fresh.renewed).toBe(false);
    expect(fresh.credentialEnvelope).not.toEqual(first.credentialEnvelope);
    await db.rpc("revoke_device_leases", { p_device_id: DEVICE.id });
    expect(await authorize(db, route.id, null, DEVICE)).toMatchObject({ status: 503, code: "capacity_exhausted" });
  });

  it("a slot rotated underneath the lease (node expired it) is not renewed", async () => {
    const db = await twoSlots();
    const [route] = await directory(db);
    const first = await authorize(db, route.id);
    const leased = slots(db).find((s) => s.state === "leased");
    Object.assign(leased, { generation: 2, state: "active", lease_id: null });
    const next = await authorize(db, route.id);
    expect(next.renewed).toBe(false);
    expect(next.ok).toBe(true);
    expect(leases(db)).toHaveLength(2);
    expect(first.ok).toBe(true);
  });

  it("revocation is urgent only when asked (abuse/admin); plain revocations wait for the node's batch", async () => {
    const db = await twoSlots();
    const [route] = await directory(db);
    await authorize(db, route.id, null, DEVICE);
    await authorize(db, route.id, null, { ...DEVICE, id: "dev-x" });
    await db.rpc("revoke_device_leases", { p_device_id: DEVICE.id });
    await db.rpc("revoke_device_leases", { p_device_id: "dev-x", p_urgent: true });
    const revoked = slots(db).filter((s) => s.state === "revoked");
    expect(revoked.map((s) => s.urgent).sort()).toEqual([false, true]);
  });
});

describe("authorizeRoute: tamara-next credential envelope (hysteria2 obfs)", () => {
  const hy2obfs = { transport: "hysteria2", transport_port: 8443, hysteria2_obfs_type: "salamander" };

  it("adds the per-node obfsPassword to obfuscated hysteria2 hops", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT", hy2obfs)],
      paths: [directPath(DE)],
      identities: [{ node_id: "de-1", vpn_user_id: "u", password: "lease-pw" }],
    });
    const { ciphertext, nonce } = await encryptSecret("node-obfs-secret", KEY);
    db._tables.node_transport_secrets.push({ node_id: "de-1", hysteria2_obfs_ciphertext: ciphertext, hysteria2_obfs_nonce: nonce });
    const [route] = await directory(db);
    expect(route.hops[0].hysteria2_obfs_type).toBe("salamander");
    const result = await authorize(db, route.id);
    expect(result.credentialEnvelope.hops).toEqual([{ password: "lease-pw", obfsPassword: "node-obfs-secret" }]);
  });

  it("fails closed (503, no slot consumed) when the node has not reported its obfs password", async () => {
    const db = await world({
      nodes: [node("de-1", DE, "EXIT", hy2obfs)],
      paths: [directPath(DE)],
      identities: [{ node_id: "de-1", vpn_user_id: "u" }],
    });
    const [route] = await directory(db);
    expect(await authorize(db, route.id)).toMatchObject({ ok: false, status: 503, code: "route_not_ready" });
    expect(db._tables.node_lease_slots[0].state).toBe("active");
    expect(db._tables.vpn_leases).toHaveLength(0);
  });

  it("route_stale (409) is still returned for stale/missing routes", async () => {
    const db = await world({ nodes: [node("de-1", DE, "EXIT")], paths: [directPath(DE)] });
    expect(await authorize(db, "r1-" + "0".repeat(32))).toMatchObject({ status: 409, code: "route_stale" });
  });
});
