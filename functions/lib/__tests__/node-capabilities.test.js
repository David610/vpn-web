import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/singbox-vpn/arcana.node.capabilities.v1.json";
import { SERVER_CLAIM_LEASE_SECONDS, capabilityReasons, fleetClaimTokenReadiness, normalizeNodeCapabilities } from "../node-capabilities.js";

describe("node capability contract", () => {
  it("normalizes the merged singbox-vpn #129 fixture", () => {
    expect(normalizeNodeCapabilities(fixture)).toEqual({ kind: "valid", values: {
      capability_contract: "arcana.node.capabilities.v1", provisioning_protocol: 2,
      claim_token_version: 1, claim_token_minimum_lease_seconds: 300,
      external_authorization_snapshot_version: 2,
    }});
  });
  it("keeps the canonical 600 second lease above the node requirement", () => {
    expect(SERVER_CLAIM_LEASE_SECONDS).toBe(600);
    expect(SERVER_CLAIM_LEASE_SECONDS).toBeGreaterThanOrEqual(fixture.capabilities.claim_token.minimum_lease_seconds);
  });
  it.each([
    [{}, "absent"],
    [{ ...fixture, capabilities: { claim_token: { version: "1", minimum_lease_seconds: 300 } } }, "malformed"],
    [{ ...fixture, capabilities: { ...fixture.capabilities, unexpected: "x".repeat(100000) } }, "valid"],
  ])("bounds known fields and ignores unknown fields", (payload, kind) => expect(normalizeNodeCapabilities(payload).kind).toBe(kind));
  it.each([
    [{ ...fixture, capability_contract: "wrong" }, "wrong capability contract"],
    [{ ...fixture, provisioning_protocol: 1 }, "old provisioning protocol"],
    [{ ...fixture, capabilities: { ...fixture.capabilities, claim_token: { version: 0, minimum_lease_seconds: 300 } } }, "claim-token version unsupported"],
    [{ ...fixture, capabilities: { ...fixture.capabilities, claim_token: { version: 1, minimum_lease_seconds: 601 } } }, "node requires lease longer than server provides"],
    [{ ...fixture, capabilities: { ...fixture.capabilities, external_authorization_snapshot: { version: 1 } } }, "external authorization snapshot version incompatible"],
  ])("rejects incompatible evidence", (payload, reason) => {
    const parsed = normalizeNodeCapabilities(payload);
    expect(capabilityReasons({ ...parsed.values, capabilities_reported_at: new Date().toISOString() })).toContain(reason);
  });
  it("rejects stale evidence", () => expect(capabilityReasons({ ...normalizeNodeCapabilities(fixture).values, capabilities_reported_at: "2000-01-01" })).toEqual(["stale heartbeat"]));
  it("computes readiness with the database's canonical lease", async () => {
    const row = { node_id: "exit-1", agent_version: "1.2.3", lifecycle_state: "READY", ...normalizeNodeCapabilities(fixture).values, capabilities_reported_at: new Date().toISOString() };
    const db = {
      from: () => ({ select: () => ({ in: async () => ({ data: [row], error: null }) }) }),
      rpc: async () => ({ data: 600, error: null }),
    };
    await expect(fleetClaimTokenReadiness(db)).resolves.toMatchObject({ ready: true, eligible_nodes: 1, compatible_nodes: 1, server_claim_lease_seconds: 600 });
  });
});
