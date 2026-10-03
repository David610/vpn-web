import { describe, expect, it } from "vitest";
import { idempotencyHash, publicClient, publicLink, validLinkInput, validLinkUpdate } from "../vpn-links.js";

describe("VPN Link boundary", () => {
  it("validates bounded container fields without calculating entitlement", () => {
    expect(validLinkInput({ name: "Office Router", routeId: "route_de_fast", maxClients: 3 }))
      .toEqual({ name: "Office Router", routeId: "route_de_fast", maxClients: 3 });
    expect(validLinkInput({ name: "Office", routeId: "bad", maxClients: 3 })).toBeNull();
    expect(validLinkUpdate({ name: "Renamed", maxClients: 0 })).toBeNull();
  });

  it("normal projections cannot leak tokens or encrypted credential material", () => {
    const client = publicClient({
      device_id: "device-a", link_id: "link-a", devices: { name: "Laptop" }, client_type: "singbox",
      desired_route_id: "route_de_fast", created_at: "now", revoked_at: null,
      subscription_token_hash: "token-hash", credential_ciphertext: "secret", credential_nonce: "nonce",
    });
    expect(client).toEqual(expect.objectContaining({ id: "device-a", name: "Laptop", status: "active" }));
    expect(JSON.stringify(client)).not.toMatch(/token|cipher|nonce|secret/i);

    const link = publicLink({ id: "link-a", name: "Office", configuration_family: "compatibility",
      desired_route_id: "route_de_fast", max_clients: 3, status: "active", created_at: "now", revoked_at: null }, 1);
    expect(link.clientCount).toBe(1);
  });

  it("domain-separates and hashes idempotency keys", async () => {
    const request = new Request("https://example.test", { headers: { "Idempotency-Key": "retry-key-123456" } });
    const hash = await idempotencyHash(request, { SUBSCRIPTION_TOKEN_HASH_KEY: "test-key-that-is-at-least-32-bytes-long" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("retry-key");
  });
});
