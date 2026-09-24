/**
 * In-memory provider adapter (spec 54 Phase 4). Implements the same
 * interface as providers/hetzner.js with no network calls, so tests and
 * local dev can exercise the admin node-creation flow without a real
 * provider account or API token. Never selected by getProviderAdapter()
 * for a live env -- see provider-adapter.js's registry comment.
 */
let counter = 0;

export function createMockProvider() {
  return {
    name: "mock",
    async createInstance({ nodeId, region }) {
      counter += 1;
      return {
        providerInstanceId: `mock-${nodeId}-${counter}`,
        ipAddress: `203.0.113.${counter % 254 + 1}`,
        region: region ?? "mock-region",
      };
    },
    async destroyInstance() {
      // No state to tear down.
    },
  };
}
