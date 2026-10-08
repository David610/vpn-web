import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));
const { onRequestGet: listLinks, onRequestPost: createLink } = await import("../links/index.js");
const { onRequestGet: getLink, onRequestPatch: updateLink } = await import("../links/[id]/index.js");
const { onRequestGet: listClients } = await import("../links/[id]/clients.js");
const { onRequestPost: createClient } = await import("../links/[id]/clients.js");
const { onRequestGet: getUsage } = await import("../links/[id]/usage.js");
const { onRequestGet: revealLink } = await import("../links/[id]/clients/[clientId]/access-link.js");
const { onRequestPost: replaceLink } = await import("../links/[id]/clients/[clientId]/replace-link.js");

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
      { id: "route_private", privacy_class: "privacy_plus", enabled: true },
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
      create_vpn_link(args, tables) {
        const id = `new-link-${tables.vpn_links.length + 1}`;
        tables.vpn_links.push({ id, account_id: args.p_account_id, name: args.p_name, configuration_family: "compatibility",
          desired_route_id: args.p_route_id, max_clients: args.p_max_clients, status: "active", location_mode: "manual",
          created_at: new Date().toISOString(), revoked_at: null });
        return { data: id, error: null };
      },
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
  it("rejects an incompatible browser Link route server-side", async () => {
    const response = await createLink({ env, request: new Request("https://example.test/api/account/links", {
      method: "POST", headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Private", routeId: "route_private", maxClients: 2 }),
    }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Route is unsupported for compatible Link clients", code: "unsupported_route" });
    expect(db.rpc).not.toHaveBeenCalledWith("create_vpn_link", expect.anything());
  });

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
    body: JSON.stringify({ name: "Laptop", clientType: "links", subscriptionId: "123" }),
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

const accessLinkRequest = (linkId, clientId) =>
  new Request(`https://example.test/api/account/links/${linkId}/clients/${clientId}/access-link`, { headers: { Authorization: "Bearer good" } });

async function createCopyableClient(key, linkId = "link-1") {
  const created = await createClient({ env, params: { id: linkId }, request: new Request(`https://example.test/api/account/links/${linkId}/clients`, {
    method: "POST", headers: { Authorization: "Bearer good", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ name: "Laptop", clientType: "links", subscriptionId: "123" }),
  }) });
  const body = await created.json();
  return { deviceId: body.deviceId, url: body.configurationUrl };
}

describe("Re-copying an access link (encrypted re-reveal)", () => {
  it("returns the same access URL again to the owner, and never stores the token in the clear", async () => {
    const { deviceId, url } = await createCopyableClient("reveal-key-0000001");
    const token = decodeURIComponent(new URL(url).pathname.split("/").pop());
    const row = db._tables.external_vpn_devices.find((client) => client.device_id === deviceId);
    expect(row.subscription_token_ciphertext).toMatch(/^\\x[0-9a-f]+$/);
    expect(JSON.stringify(row)).not.toContain(token);

    const response = await revealLink({ env, request: accessLinkRequest("link-1", deviceId), params: { id: "link-1", clientId: deviceId } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ configurationUrl: url });
  });

  it("does not reveal another account's access link", async () => {
    const response = await revealLink({ env, request: accessLinkRequest("link-2", "device-2"), params: { id: "link-2", clientId: "device-2" } });
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toMatch(/sub\//);
  });

  it("asks the owner to replace a link created before copying existed", async () => {
    const response = await revealLink({ env, request: accessLinkRequest("link-1", "device-1"), params: { id: "link-1", clientId: "device-1" } });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("access_link_unavailable");
  });

  it("returns the new link after a replacement and no longer the old one", async () => {
    const { deviceId, url } = await createCopyableClient("reveal-key-0000002");
    const replaced = await replaceLink({ env, params: { id: "link-1", clientId: deviceId }, request: new Request("https://example.test/x", { method: "POST", headers: { Authorization: "Bearer good" } }) });
    const newUrl = (await replaced.json()).subscriptionUrl;
    expect(newUrl).not.toBe(url);
    const response = await revealLink({ env, request: accessLinkRequest("link-1", deviceId), params: { id: "link-1", clientId: deviceId } });
    expect(await response.json()).toEqual({ configurationUrl: newUrl });
  });

  it("refuses a ciphertext moved onto a different client", async () => {
    const a = await createCopyableClient("reveal-key-0000003");
    const b = await createCopyableClient("reveal-key-0000004");
    const rowA = db._tables.external_vpn_devices.find((client) => client.device_id === a.deviceId);
    const rowB = db._tables.external_vpn_devices.find((client) => client.device_id === b.deviceId);
    rowB.subscription_token_ciphertext = rowA.subscription_token_ciphertext;
    rowB.subscription_token_nonce = rowA.subscription_token_nonce;
    const response = await revealLink({ env, request: accessLinkRequest("link-1", b.deviceId), params: { id: "link-1", clientId: b.deviceId } });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain(new URL(a.url).pathname);
  });

  it("does not reveal a revoked client's link", async () => {
    const { deviceId } = await createCopyableClient("reveal-key-0000005");
    db._tables.external_vpn_devices.find((client) => client.device_id === deviceId).revoked_at = "2026-02-01";
    const response = await revealLink({ env, request: accessLinkRequest("link-1", deviceId), params: { id: "link-1", clientId: deviceId } });
    expect(response.status).toBe(404);
  });

  it("requires a session", async () => {
    const response = await revealLink({ env, request: new Request("https://example.test/x"), params: { id: "link-1", clientId: "device-1" } });
    expect(response.status).toBe(401);
  });

  it("keeps ciphertext out of the Link list and detail responses", async () => {
    await createCopyableClient("reveal-key-0000006");
    const list = JSON.stringify(await (await listLinks({ env, request })).json());
    const detail = JSON.stringify(await (await getLink({ env, request, params: { id: "link-1" } })).json());
    for (const body of [list, detail]) expect(body).not.toMatch(/cipher|nonce|\\x[0-9a-f]{8}/i);
  });
});

describe("Link location mode", () => {
  const post = (body) => createLink({ env, request: new Request("https://example.test/api/account/links", {
    method: "POST", headers: { Authorization: "Bearer good", "Content-Type": "application/json" }, body: JSON.stringify(body) }) });

  it("records an automatically chosen location", async () => {
    const response = await post({ name: "Auto", routeId: "route_one", maxClients: 1, locationMode: "auto" });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(db._tables.vpn_links.find((link) => link.id === id).location_mode).toBe("auto");
    const detail = await (await getLink({ env, request, params: { id } })).json();
    expect(detail.link.locationMode).toBe("auto");
  });

  it("defaults to a manual location and rejects unknown modes", async () => {
    const manual = await (await post({ name: "Manual", routeId: "route_one", maxClients: 1 })).json();
    expect(db._tables.vpn_links.find((link) => link.id === manual.id).location_mode).toBe("manual");
    expect((await post({ name: "Bad", routeId: "route_one", maxClients: 1, locationMode: "fastest" })).status).toBe(400);
  });
});

describe("Link list primary client", () => {
  it("returns the first active client so the UI can copy a link without extra requests", async () => {
    db._tables.external_vpn_devices.find((client) => client.device_id === "device-1").revoked_at = "2026-01-02";
    await createCopyableClient("primary-key-0000001");
    const { links } = await (await listLinks({ env, request })).json();
    const link = links.find((item) => item.id === "link-1");
    expect(link.primaryClientId).toMatch(/^created-/);
    expect(links.find((item) => item.id === "link-3").primaryClientId).toBeNull();
  });
});
