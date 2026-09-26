import { describe, it, expect } from "vitest";
import { renderRoutes } from "../route-directory.js";

const EXIT_DE = {
  nodeId: "de-fsn-001",
  role: "EXIT",
  locationId: "loc-de",
  lifecycleState: "READY",
  configuredUsers: 5,
  maxSessions: 100,
  hostname: "de-fsn-001.nodes.example.test",
  ipAddress: "203.0.113.10",
  failureDomain: "hetzner/de",
  transport: "vless-reality",
  transportPort: 443,
  tlsServerName: "decoy1.example.test",
  realityPublicKey: "pub-de",
  realityShortId: "sid-de",
  realityFingerprint: "chrome",
  vlessFlow: "xtls-rprx-vision",
};

const RELAY_SE = {
  ...EXIT_DE,
  nodeId: "se-fsn-001",
  role: "RELAY",
  locationId: "loc-se",
  hostname: "se-fsn-001.nodes.example.test",
  ipAddress: "203.0.113.20",
  failureDomain: "hetzner/se",
  tlsServerName: "decoy2.example.test",
  realityPublicKey: "pub-se",
  realityShortId: "sid-se",
};

const LOCATIONS = [
  { id: "loc-de", countryCode: "DE", displayName: "Germany" },
  { id: "loc-se", countryCode: "SE", displayName: "Sweden" },
];

describe("renderRoutes", () => {
  it("produces one fast route per exit location with an eligible node", () => {
    const { routes } = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([
      {
        id: "de-fast",
        label: "Germany",
        region: "DE",
        mode: "fast",
        priority: 100,
        failure_domain: "hetzner/de",
        hops: [
          {
            transport: "vless-reality",
            server_address: "203.0.113.10",
            server_port: 443,
            tls_server_name: "decoy1.example.test",
            reality_public_key: "pub-de",
            reality_short_id: "sid-de",
            reality_fingerprint: "chrome",
            vless_flow: "xtls-rprx-vision",
          },
        ],
      },
    ]);
  });

  it("produces nothing for a location with no eligible node", () => {
    const noneReady = { ...EXIT_DE, lifecycleState: "FAILED" };
    const { routes } = renderRoutes({ nodes: [noneReady], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("excludes a node that has never reported transport params", () => {
    const { transport, ...withoutTransport } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutTransport], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("excludes a node that has no ip_address yet -- server_address must be a real address, never a hostname", () => {
    const { ipAddress, ...withoutIp } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutIp], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("produces one privacy_plus route per enabled allowed_paths pair with both hops eligible", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE, RELAY_SE],
      locations: LOCATIONS,
      allowedPaths: [{ entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    const privacyRoute = routes.find((r) => r.mode === "privacy_plus");
    expect(privacyRoute).toMatchObject({ id: "se-de-privacy", mode: "privacy_plus" });
    expect(privacyRoute.hops).toHaveLength(2);
    expect(privacyRoute.hops[0].server_address).toBe("203.0.113.20");
    expect(privacyRoute.hops[1].server_address).toBe("203.0.113.10");
  });

  it("omits a privacy_plus pair entirely when only one hop has an eligible node -- never half-populated", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE], // no RELAY node for loc-se
      locations: LOCATIONS,
      allowedPaths: [{ entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    expect(routes.find((r) => r.mode === "privacy_plus")).toBeUndefined();
  });

  it("respects CANARY session cap via isUnderCapacity -- a full canary node is excluded", () => {
    const fullCanary = { ...EXIT_DE, lifecycleState: "CANARY", configuredUsers: 10, maxSessions: 1000 };
    const { routes } = renderRoutes({ nodes: [fullCanary], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("omits failure_domain from the route object when the node has none set", () => {
    const { failureDomain, ...withoutDomain } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutDomain], locations: LOCATIONS, allowedPaths: [] });
    expect(routes[0]).not.toHaveProperty("failure_domain");
  });
});
