import { createHetznerProvider } from "./providers/hetzner.js";
import { createMockProvider } from "./providers/mock.js";

/**
 * Provider adapter interface (spec 54 Phase 4):
 *
 *   findInstanceByNodeId(nodeId)
 *     -> { providerInstanceId, ipAddress, ipv6Network, region, status } | null
 *   createInstance({ nodeId, region, userData, serverType?, image? })
 *     -> { providerInstanceId, ipAddress, ipv6Network, region, status }
 *   destroyInstance({ providerInstanceId }) -> void   (404 = success)
 *
 * Adapters must label/tag every instance with its node id so that
 * findInstanceByNodeId() can adopt an instance whose create response was
 * lost -- the fleet reconciler (fleet-operations.js) relies on this to
 * never create a second server for one node. user_data is built by the
 * caller (node-bootstrap.js); adapters stay ignorant of bootstrap content.
 *
 * Every adapter is stateless w.r.t. this process -- all durable state
 * (provider, provider_instance_id, ip_address, lifecycle_state) lives on
 * the nodes row, written by the caller (functions/api/admin/nodes.js), not
 * by the adapter itself. This mirrors how node-lifecycle.js is pure and
 * the DB write happens one layer up.
 *
 * "mock" is for tests and local dev only. It is intentionally excluded
 * from getProviderAdapter() so a misconfigured PROVIDER_NAME env var (or a
 * request that names it) can never fabricate a fake, unreachable node in
 * production -- see functions/lib/providers/__tests__/provider-adapter.test.js.
 */
const REAL_PROVIDERS = {
  hetzner: createHetznerProvider,
};

export function getProviderAdapter(providerName, env) {
  const factory = REAL_PROVIDERS[providerName];
  if (!factory) {
    throw new Error(`Unknown or unsupported provider: ${providerName}`);
  }
  return factory(env);
}

export function getMockProviderAdapter() {
  return createMockProvider();
}
