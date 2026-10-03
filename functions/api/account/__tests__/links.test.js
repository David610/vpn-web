import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));
const { onRequestGet: listLinks } = await import("../links/index.js");
const { onRequestGet: getLink, onRequestPatch: updateLink } = await import("../links/[id]/index.js");
const { onRequestGet: listClients } = await import("../links/[id]/clients.js");
const { onRequestPost: createClient } = await import("../links/[id]/clients.js");
const { onRequestGet: getUsage } = await import("../links/[id]/usage.js");

const env = {
  SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key",
  SUBSCRIPTION_TOKEN_HASH_KEY: "test-subscription-token-key-32-bytes",
  VPN_SECRETS_ENCRYPTION_KEY: "11".repeat(32),
};
const request = new Request("https://example.test/api/account/links", { headers: { Authorization: "Bearer good" } });

function seed() {
  return makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }, { id: "acct-2" }],
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    vpn_links: [
      { id: "link-1", account_id: "acct-1", name: "Mine", configuration_family: "compatibility", desired_route_id: "route_one", max_clients: 3, status: "active", created_at: "2026-01-01", revoked_at: null },
      { id: "link-3", account_id: "acct-1", name: "Also mine", configuration_family: "compatibility", desired_route_id: "route_one", max_clients: 3, status: "active", created_at: "2026-01-02", revoked_at: null },
      { id: "link-2", account_id: "acct-2", name: "Other", configuration_family: "compatibility", desired_route_id: "route_two", max_clients: 3, status: "active", created_at: "2026-01-01", revoked_at: null },
    ],
    logical_routes: [
      { id: "route_one", privacy_class: "fast", enabled: true },
      { id: "route_two", privacy_class: "fast", enabled: true },
    ],
    external_vpn_devices: [
      { device_id: "device-1", account_id: "acct-1", link_id: "link-1", client_type: "singbox", desired_route_id: "route_one", created_at: "2026-01-01", revoked_at: null, subscription_token_hash: "not-public", credential_ciphertext: "not-public" },
      { device_id: "device-2", account_id: "acct-2", link_id: "link-2", client_type: "singbox", desired_route_id: "route_two", created_at: "2026-01-01", revoked_at: null },
    ],
    vpn_link_usage_daily: [
      { account_id: "acct-1", link_id: "link-1", device_id: "device-1", bucket_date: "2026-01-01", rx_bytes: 1, tx_bytes: 2 },
      { account_id: "acct-2", link_id: "link-2", device_id: "device-2", bucket_date: "2026-01-01", rx_bytes: 999, tx_bytes: 999 },
    ],
  }, {
    user: { id: "user-1", email: "owner@example.test" },
    rpc: {
      update_vpn_link(args, tables) {
        const owned = tables.vpn_links.some((link) => link.id === args.p_link_id && link.account_id === args.p_account_id);
        return { data: owned, error: null };
      },
      create_vpn_link_client(args, tables) {
        const existing = tables.external_vpn_devices.find((client) =>
          client.link_id === args.p_link_id && client.idempotency_key === args.p_idempotency_key);
        if (existing) return { data: existing.device_id, error: null };
        const deviceId = `created-${tables.external_vpn_devices.length + 1}`;
        tables.external_vpn_devices.push({
          device_id: deviceId, account_id: args.p_account_id, link_id: args.p_link_id,
          idempotency_key: args.p_idempotency_key, client_type: args.p_client_type,
          subscription_token_hash: args.p_token_hash, desired_route_id: "route_one",
          created_at: new Date().toISOString(), revoked_at: null,
        });
        return { data: deviceId, error: null };
      },
    },
  });
}

beforeEach(() => { db = seed(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("Link ownership boundary", () => {
  it("lists only the caller's Links and does not expose secrets", async () => {
    const response = await listLinks({ env, request });
    const body = await response.json();
    expect(body.links.map((link) => link.id)).toEqual(["link-1", "link-3"]);
    expect(JSON.stringify(body)).not.toMatch(/not-public|token|cipher/i);
  });

  it("does not read another account's Link", async () => {
    const response = await getLink({ env, request, params: { id: "link-2" } });
    expect(response.status).toBe(404);
  });

  it("does not list another account's clients", async () => {
    const response = await listClients({ env, request, params: { id: "link-2" } });
    expect(response.status).toBe(404);
  });

  it("cannot modify another account's Link", async () => {
    const patch = new Request("https://example.test/api/account/links/link-2", {
      method: "PATCH", headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stolen", maxClients: 1 }),
    });
    const response = await updateLink({ env, request: patch, params: { id: "link-2" } });
    expect(response.status).toBe(404);
    expect(db._tables.vpn_links.find((link) => link.id === "link-2").name).toBe("Other");
  });

  it("does not return another account's usage", async () => {
    const response = await getUsage({ env, request, params: { id: "link-2" } });
    expect(response.status).toBe(404);
  });

  it("cannot create a client under another account's Link", async () => {
    const response = await createClient({ env, params: { id: "link-2" }, request: clientRequest("foreign-link-key") });
    expect(response.status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalledWith("create_vpn_link_client", expect.anything());
  });
});

function clientRequest(key) {
  return new Request("https://example.test/api/account/links/link-1/clients", {
    method: "POST",
    headers: { Authorization: "Bearer good", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ name: "Laptop", clientType: "singbox", subscriptionId: "123" }),
  });
}

describe("Link client idempotency and one-time secret delivery", () => {
  it("returns configuration once and never reveals it on an identical retry after response loss", async () => {
    const first = await createClient({ env, params: { id: "link-1" }, request: clientRequest("response-loss-key-1") });
    expect(first.status).toBe(201);
    expect((await first.json()).configurationUrl).toMatch(/^https:\/\/example\.test\/sub\//);

    const retry = await createClient({ env, params: { id: "link-1" }, request: clientRequest("response-loss-key-1") });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deviceId: "created-3", replayed: true });
  });

  it("serializes concurrent identical retries to one stored client and no second secret", async () => {
    const [a, b] = await Promise.all([
      createClient({ env, params: { id: "link-1" }, request: clientRequest("concurrent-key-01") }),
      createClient({ env, params: { id: "link-1" }, request: clientRequest("concurrent-key-01") }),
    ]);
    const bodies = await Promise.all([a.json(), b.json()]);
    expect(db._tables.external_vpn_devices.filter((client) => client.device_id.startsWith("created-"))).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(bodies.filter((body) => body.configurationUrl)).toHaveLength(1);
  });

  it("scopes the same key by Link and permits different keys on one Link", async () => {
    await createClient({ env, params: { id: "link-1" }, request: clientRequest("scope-key-shared") });
    await createClient({ env, params: { id: "link-1" }, request: clientRequest("scope-key-different") });
    const other = await createClient({ env, params: { id: "link-3" }, request: clientRequest("scope-key-shared") });
    expect(other.status).toBe(201);
    expect(db._tables.external_vpn_devices.filter((client) => client.link_id === "link-1" && client.device_id.startsWith("created-"))).toHaveLength(2);
    expect(db._tables.external_vpn_devices.filter((client) => client.link_id === "link-3" && client.device_id.startsWith("created-"))).toHaveLength(1);
  });
});
