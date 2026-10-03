import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

const requireUser = vi.fn();
vi.mock("../../../lib/user-auth.js", () => ({ requireUser }));
let db;
vi.mock("../../../lib/account-http.js", () => ({ adminClient: vi.fn(() => db) }));

const list = await import("../index.js");
const detail = await import("../[id]/index.js");
const clients = await import("../[id]/clients.js");
const nestedClient = await import("../[id]/clients/[clientId].js");
const replace = await import("../[id]/clients/[clientId]/replace-link.js");

const LINK_A = "11111111-1111-4111-8111-111111111111";
const LINK_B = "22222222-2222-4222-8222-222222222222";
const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const env = { SUBSCRIPTION_TOKEN_HASH_KEY: "test-subscription-token-key-32-bytes", VPN_SECRETS_ENCRYPTION_KEY: "11".repeat(32) };

function seed({ empty = false, capacity = false, wrongSubscription = false } = {}) {
  return makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }, { id: "acct-2" }],
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    logical_routes: [
      { id: "route_de_fast", display_name: "Germany", region: "DE", privacy_class: "fast", enabled: true },
      { id: "route_private", display_name: "Privacy+", region: "DE", privacy_class: "privacy_plus", enabled: true },
    ],
    vpn_links: empty ? [] : [
      { id: LINK_A, account_id: "acct-1", name: "Travel", configuration_family: "compatibility", desired_route_id: "route_de_fast", max_clients: 3, status: "active", created_at: "2026-10-03T12:00:00Z", revoked_at: null },
      { id: LINK_B, account_id: "acct-1", name: "Home", configuration_family: "compatibility", desired_route_id: "route_de_fast", max_clients: 3, status: "active", created_at: "2026-10-03T13:00:00Z", revoked_at: null },
    ],
    external_vpn_devices: empty ? [] : [
      { device_id: CLIENT_A, account_id: "acct-1", link_id: LINK_A, client_type: "links", devices: { name: "Laptop" }, created_at: "2026-10-03T12:01:00Z", last_subscription_fetch_at: null, revoked_at: null, subscription_token_hash: "old-token-hash" },
      { device_id: CLIENT_B, account_id: "acct-1", link_id: LINK_B, client_type: "links", devices: { name: "Phone" }, created_at: "2026-10-03T13:01:00Z", revoked_at: null, subscription_token_hash: "other-token-hash" },
    ],
  }, { user: { id: "user-1" }, rpc: {
    create_vpn_link(args, tables) {
      tables.vpn_links.push({ id: CREATED, account_id: args.p_account_id, name: args.p_name, configuration_family: "compatibility", desired_route_id: args.p_route_id, max_clients: args.p_max_clients, status: "active", created_at: new Date().toISOString(), revoked_at: null });
      return { data: CREATED, error: null };
    },
    create_vpn_link_client(args, tables) {
      if (wrongSubscription) return { data: null, error: { message: "subscription_not_entitled" } };
      if (capacity) return { data: null, error: { message: "link_capacity_full" } };
      const prior = tables.external_vpn_devices.find((row) => row.link_id === args.p_link_id && row.idempotency_key === args.p_idempotency_key);
      if (prior) return { data: prior.device_id, error: null };
      tables.external_vpn_devices.push({ device_id: CREATED, account_id: args.p_account_id, link_id: args.p_link_id,
        client_type: args.p_client_type, name: args.p_name, created_at: "2026-10-03T14:00:00Z", revoked_at: null,
        subscription_token_hash: args.p_token_hash, idempotency_key: args.p_idempotency_key });
      return { data: CREATED, error: null };
    },
    revoke_external_vpn_device(args, tables) {
      const row = tables.external_vpn_devices.find((item) => item.device_id === args.p_device_id && item.account_id === args.p_account_id);
      if (!row) return { data: false, error: null }; row.revoked_at = "2026-10-03T15:00:00Z"; return { data: true, error: null };
    },
    revoke_vpn_link(args, tables) {
      const row = tables.vpn_links.find((item) => item.id === args.p_link_id && item.account_id === args.p_account_id && item.status === "active");
      if (!row) return { data: false, error: null }; row.status = "revoked"; row.revoked_at = "2026-10-03T15:00:00Z";
      tables.external_vpn_devices.filter((item) => item.link_id === row.id && !item.revoked_at).forEach((item) => { item.revoked_at = row.revoked_at; });
      return { data: true, error: null };
    },
  } });
}

function request(path, { method = "GET", body, key = "idempotency-key-1234" } = {}) {
  return new Request(`https://arcana.example${path}`, { method, headers: { Authorization: "Bearer good", ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body: body && JSON.stringify(body) });
}
const context = (path, params = {}, options) => ({ env, params, request: request(path, options) });

beforeEach(() => {
  db = seed();
  requireUser.mockReset().mockResolvedValue({ user: { id: "user-1" }, claims: { session_id: "session" }, response: null });
});

describe("/v1/links contract", () => {
  it("returns the exact empty list envelope", async () => { db = seed({ empty: true }); expect(await (await list.onRequestGet(context("/v1/links"))).json()).toEqual({ links: [] }); });
  it("lists normalized links with friendly labels and no secrets", async () => {
    const body = await (await list.onRequestGet(context("/v1/links"))).json();
    expect(body.links[0]).toEqual({ id: LINK_A, name: "Travel", status: "active", route_id: "route_de_fast", route_label: "Germany", configuration_family: "compatibility", active_clients: 1, max_clients: 3, created_at: "2026-10-03T12:00:00Z", revoked_at: null });
    expect(JSON.stringify(body)).not.toMatch(/token|cipher|nonce|node|password|uuid/i);
  });
  it("creates a supported route and rejects an unsupported route fail-closed", async () => {
    const ok = await list.onRequestPost(context("/v1/links", {}, { method: "POST", body: { name: "Work", route_id: "route_de_fast", max_clients: 2 } }));
    expect(ok.status).toBe(201); expect((await ok.json()).link).toMatchObject({ id: CREATED, route_label: "Germany", active_clients: 0 });
    const bad = await list.onRequestPost(context("/v1/links", {}, { method: "POST", body: { name: "Work", route_id: "route_private", max_clients: 2 } }));
    expect(bad.status).toBe(422); expect(await bad.json()).toEqual({ error: "Route is unsupported for compatible Link clients", code: "unsupported_route" });
  });
  it("returns detail without secrets or node identifiers", async () => {
    const response = await detail.onRequestGet(context(`/v1/links/${LINK_A}`, { id: LINK_A })); const body = await response.json();
    expect(body.clients).toEqual([{ id: CLIENT_A, name: "Laptop", status: "active", client_type: "links", created_at: "2026-10-03T12:01:00Z", last_seen_at: null, revoked_at: null }]);
    expect(JSON.stringify(body)).not.toMatch(/token|cipher|nonce|node_id|credential/i);
  });
  it("conceals a foreign Link and rejects malformed ids", async () => {
    expect((await detail.onRequestGet(context(`/v1/links/${LINK_B}`, { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }))).status).toBe(404);
    expect((await detail.onRequestGet(context("/v1/links/nope", { id: "nope" }))).status).toBe(400);
  });
  it("issues a client once, then omits every secret on response-loss retry", async () => {
    const opts = { method: "POST", body: { name: "Tablet", subscription_id: "123" }, key: "response-loss-key-1" };
    const first = await clients.onRequestPost(context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, opts)); const firstBody = await first.json();
    expect(first.status).toBe(201); expect(firstBody).toMatchObject({ client: { id: CREATED, client_type: "links" }, replayed: false, shown_once: true }); expect(firstBody.configuration_url).toMatch(/^https:\/\/arcana\.example\/sub\//);
    const replay = await clients.onRequestPost(context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, opts)); const replayBody = await replay.json();
    expect(replay.status).toBe(200); expect(replayBody).toEqual({ client: expect.objectContaining({ id: CREATED }), replayed: true });
    expect(JSON.stringify(replayBody)).not.toMatch(/configuration_url|subscription_token|credential|shown_once/);
  });
  it("serializes concurrent identical client creation to one secret", async () => {
    const ctx = () => context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, { method: "POST", body: { name: "Tablet", subscription_id: "123" }, key: "concurrent-key-123" });
    const responses = await Promise.all([clients.onRequestPost(ctx()), clients.onRequestPost(ctx())]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((r) => r.json())); expect(bodies.filter((b) => b.configuration_url)).toHaveLength(1);
  });
  it("reports capacity exhaustion and wrong subscription ownership", async () => {
    const opts = { method: "POST", body: { name: "Tablet", subscription_id: "123" } };
    db = seed({ capacity: true }); let response = await clients.onRequestPost(context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, opts)); expect(response.status).toBe(409); expect((await response.json()).code).toBe("capacity_exhausted");
    db = seed({ wrongSubscription: true }); response = await clients.onRequestPost(context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, opts)); expect(response.status).toBe(404); expect((await response.json()).code).toBe("subscription_not_found");
  });
  it("rejects the same-account Link A/client B confused deputy", async () => {
    const response = await replace.onRequestPost(context(`/v1/links/${LINK_A}/clients/${CLIENT_B}/replace-link`, { id: LINK_A, clientId: CLIENT_B }, { method: "POST" }));
    expect(response.status).toBe(404); expect((await response.json()).code).toBe("client_not_found");
  });
  it("replaces only the access token, invalidates the old hash, and returns a fresh URL once", async () => {
    const row = db._tables.external_vpn_devices[0]; const oldHash = row.subscription_token_hash;
    const response = await replace.onRequestPost(context(`/v1/links/${LINK_A}/clients/${CLIENT_A}/replace-link`, { id: LINK_A, clientId: CLIENT_A }, { method: "POST" })); const body = await response.json();
    expect(response.status).toBe(200); expect(body).toMatchObject({ client: { id: CLIENT_A }, shown_once: true }); expect(body.configuration_url).toMatch(/^https:\/\/arcana\.example\/sub\//); expect(row.subscription_token_hash).not.toBe(oldHash);
    expect(JSON.stringify(body)).not.toContain(oldHash);
  });
  it("revokes one client, then revokes a Link and its active children", async () => {
    let response = await nestedClient.onRequestDelete(context(`/v1/links/${LINK_A}/clients/${CLIENT_A}`, { id: LINK_A, clientId: CLIENT_A }, { method: "DELETE" })); expect(response.status).toBe(204); expect(db._tables.external_vpn_devices[1].revoked_at).toBeNull();
    response = await detail.onRequestDelete(context(`/v1/links/${LINK_B}`, { id: LINK_B }, { method: "DELETE" })); expect(response.status).toBe(204); expect(db._tables.external_vpn_devices[1].revoked_at).not.toBeNull();
  });
  it("rejects mutation of a revoked Link", async () => {
    await detail.onRequestDelete(context(`/v1/links/${LINK_A}`, { id: LINK_A }, { method: "DELETE" }));
    const response = await clients.onRequestPost(context(`/v1/links/${LINK_A}/clients`, { id: LINK_A }, { method: "POST", body: { name: "Tablet", subscription_id: "123" } })); expect(response.status).toBe(404);
  });
  it("returns 401 on session expiration", async () => {
    requireUser.mockResolvedValue({ user: null, claims: null, response: new Response(null, { status: 401 }) });
    const response = await list.onRequestGet(context("/v1/links")); expect(response.status).toBe(401); expect(await response.json()).toEqual({ message: "Please log in again." });
  });
});
