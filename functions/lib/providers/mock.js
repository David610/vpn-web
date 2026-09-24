/**
 * In-memory provider adapter (spec 54 Phase 4). Implements the same
 * interface as providers/hetzner.js with no network calls, so tests and
 * local dev can exercise the admin node-creation flow without a real
 * provider account or API token. Never selected by getProviderAdapter()
 * for a live env -- see provider-adapter.js's registry comment.
 */
let counter = 0;

export function createMockProvider() {
  const byNodeId = new Map();
  return {
    name: "mock",
    async findInstanceByNodeId(nodeId) {
      return byNodeId.get(nodeId) ?? null;
    },
    async createInstance({ nodeId, region }) {
      counter += 1;
      const instance = {
        providerInstanceId: `mock-${nodeId}-${counter}`,
        ipAddress: `203.0.113.${counter % 254 + 1}`,
        ipv6Network: null,
        region: region ?? "mock-region",
        status: "running",
      };
      byNodeId.set(nodeId, instance);
      return instance;
    },
    async destroyInstance({ providerInstanceId }) {
      for (const [nodeId, instance] of byNodeId) {
        if (instance.providerInstanceId === providerInstanceId) byNodeId.delete(nodeId);
      }
    },
  };
}
