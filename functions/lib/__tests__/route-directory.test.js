import { describe, it, expect } from "vitest";
import { renderRoutes } from "../route-directory.js";
import { routeIdFor, MAX_FAST_CANDIDATES_PER_LOCATION, MAX_PRIVACY_CANDIDATES_PER_PATH } from "../route-candidates.js";

const DIRECT = [{ entryLocationId: null, exitLocationId: "loc-de" }];
const ID_RE = /^r1-[0-9a-f]{32}$/;

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
    const { routes } = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes).toEqual([
      {
        id: routeIdFor({ mode: "fast", exitLocationId: "loc-de", nodes: [EXIT_DE] }),
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
    const { routes } = renderRoutes({ nodes: [noneReady], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes).toEqual([]);
  });

  it("excludes a node that has never reported transport params", () => {
    const { transport, ...withoutTransport } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutTransport], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes).toEqual([]);
  });

  it("excludes a node that has no ip_address yet -- server_address must be a real address, never a hostname", () => {
    const { ipAddress, ...withoutIp } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutIp], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes).toEqual([]);
  });

  it("produces one privacy_plus route per enabled allowed_paths pair with both hops eligible", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE, RELAY_SE],
      locations: LOCATIONS,
      allowedPaths: [...DIRECT, { entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    const privacyRoute = routes.find((r) => r.mode === "privacy_plus");
    expect(privacyRoute.mode).toBe("privacy_plus");
    expect(privacyRoute.id).toMatch(ID_RE);
    expect(privacyRoute.hops).toHaveLength(2);
    expect(privacyRoute.hops[0].server_address).toBe("203.0.113.20");
    expect(privacyRoute.hops[1].server_address).toBe("203.0.113.10");
  });

  it("omits a privacy_plus pair entirely when only one hop has an eligible node -- never half-populated", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE], // no RELAY node for loc-se
      locations: LOCATIONS,
      allowedPaths: [...DIRECT, { entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    expect(routes.find((r) => r.mode === "privacy_plus")).toBeUndefined();
  });

  it("respects CANARY session cap via isUnderCapacity -- a full canary node is excluded", () => {
    const fullCanary = { ...EXIT_DE, lifecycleState: "CANARY", configuredUsers: 10, maxSessions: 1000 };
    const { routes } = renderRoutes({ nodes: [fullCanary], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes).toEqual([]);
  });

  it("omits failure_domain from the route object when the node has none set", () => {
    const { failureDomain, ...withoutDomain } = EXIT_DE;
    const { routes } = renderRoutes({ nodes: [withoutDomain], locations: LOCATIONS, allowedPaths: DIRECT });
    expect(routes[0]).not.toHaveProperty("failure_domain");
  });

  it("publishes no fast route without a direct allowed_paths row (authorize would refuse it)", () => {
    const { routes } = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: [] });
    expect(routes).toEqual([]);
  });

  it("never exposes internal node ids", () => {
    const { routes } = renderRoutes({
      nodes: [EXIT_DE, RELAY_SE],
      locations: LOCATIONS,
      allowedPaths: [...DIRECT, { entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    const text = JSON.stringify(routes);
    expect(text).not.toContain("de-fsn-001");
    expect(text).not.toContain("se-fsn-001");
    expect(text).not.toContain("hopNodeIds");
  });

  it("changes the route id when any published hop metadata changes (stale metadata can never authorize)", () => {
    const a = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: DIRECT }).routes[0].id;
    const b = renderRoutes({ nodes: [{ ...EXIT_DE, realityPublicKey: "rotated" }], locations: LOCATIONS, allowedPaths: DIRECT }).routes[0].id;
    const c = renderRoutes({ nodes: [{ ...EXIT_DE, ipAddress: "203.0.113.99" }], locations: LOCATIONS, allowedPaths: DIRECT }).routes[0].id;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("keeps the route id stable when only load changes", () => {
    const a = renderRoutes({ nodes: [EXIT_DE], locations: LOCATIONS, allowedPaths: DIRECT }).routes[0].id;
    const b = renderRoutes({ nodes: [{ ...EXIT_DE, configuredUsers: 50 }], locations: LOCATIONS, allowedPaths: DIRECT }).routes[0].id;
    expect(a).toBe(b);
  });

  it("publishes multiple fast candidates, one per failure domain first, bounded and deterministic", () => {
    const exits = [
      { ...EXIT_DE, nodeId: "de-a1", ipAddress: "203.0.113.1", failureDomain: "hetzner/fsn", configuredUsers: 1 },
      { ...EXIT_DE, nodeId: "de-a2", ipAddress: "203.0.113.2", failureDomain: "hetzner/fsn", configuredUsers: 2 },
      { ...EXIT_DE, nodeId: "de-b1", ipAddress: "203.0.113.3", failureDomain: "contabo/nbg", configuredUsers: 9 },
      { ...EXIT_DE, nodeId: "de-c1", ipAddress: "203.0.113.4", failureDomain: "ovh/fra", configuredUsers: 20 },
      { ...EXIT_DE, nodeId: "de-a3", ipAddress: "203.0.113.5", failureDomain: "hetzner/fsn", configuredUsers: 0 },
    ];
    const first = renderRoutes({ nodes: exits, locations: LOCATIONS, allowedPaths: DIRECT }).routes;
    const again = renderRoutes({ nodes: [...exits].reverse(), locations: LOCATIONS, allowedPaths: DIRECT }).routes;
    expect(first).toEqual(again);
    expect(first).toHaveLength(MAX_FAST_CANDIDATES_PER_LOCATION);
    expect(first.map((r) => r.failure_domain)).toEqual(["hetzner/fsn", "contabo/nbg", "ovh/fra"]);
    expect(first[0].hops[0].server_address).toBe("203.0.113.5"); // least-loaded in the first domain
    expect(first.map((r) => r.priority)).toEqual([100, 90, 80]);
    expect(new Set(first.map((r) => r.id)).size).toBe(first.length);
  });

  it("publishes multiple privacy_plus candidates across relays and exits, never relay==exit, bounded", () => {
    const relays = [0, 1, 2, 3].map((i) => ({ ...RELAY_SE, nodeId: `se-r${i}`, ipAddress: `203.0.113.${20 + i}`, failureDomain: `p${i}/se` }));
    const exits = [0, 1].map((i) => ({ ...EXIT_DE, nodeId: `de-e${i}`, ipAddress: `203.0.113.${40 + i}`, failureDomain: `q${i}/de` }));
    const { routes } = renderRoutes({
      nodes: [...relays, ...exits],
      locations: LOCATIONS,
      allowedPaths: [{ entryLocationId: "loc-se", exitLocationId: "loc-de" }],
    });
    const privacy = routes.filter((r) => r.mode === "privacy_plus");
    expect(privacy).toHaveLength(MAX_PRIVACY_CANDIDATES_PER_PATH);
    for (const route of privacy) {
      expect(route.hops).toHaveLength(2);
      expect(route.hops[0].server_address).not.toBe(route.hops[1].server_address);
    }
    expect(new Set(privacy.map((r) => r.hops[0].server_address)).size).toBe(3);
    expect(new Set(privacy.map((r) => r.hops[1].server_address)).size).toBe(2);
  });
});
