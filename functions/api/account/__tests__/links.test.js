import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase } from "../../../lib/__tests__/fake-supabase.js";

let db;
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => db) }));
const { onRequestGet: listLinks } = await import("../links/index.js");
const { onRequestGet: getLink, onRequestPatch: updateLink } = await import("../links/[id]/index.js");
const { onRequestGet: listClients } = await import("../links/[id]/clients.js");
const { onRequestGet: getUsage } = await import("../links/[id]/usage.js");

const env = { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "key" };
const request = new Request("https://example.test/api/account/links", { headers: { Authorization: "Bearer good" } });

function seed() {
  return makeFakeSupabase({
    customer_accounts: [{ id: "acct-1" }, { id: "acct-2" }],
    account_members: [{ account_id: "acct-1", user_id: "user-1", role: "owner" }],
    vpn_links: [
      { id: "link-1", account_id: "acct-1", name: "Mine", configuration_family: "compatibility", desired_route_id: "route_one", max_clients: 3, status: "active", created_at: "2026-01-01", revoked_at: null },
      { id: "link-2", account_id: "acct-2", name: "Other", configuration_family: "compatibility", desired_route_id: "route_two", max_clients: 3, status: "active", created_at: "2026-01-01", revoked_at: null },
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
    },
  });
}

beforeEach(() => { db = seed(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("Link ownership boundary", () => {
  it("lists only the caller's Links and does not expose secrets", async () => {
    const response = await listLinks({ env, request });
    const body = await response.json();
    expect(body.links.map((link) => link.id)).toEqual(["link-1"]);
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
});
