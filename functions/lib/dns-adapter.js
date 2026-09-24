import { createCloudflareDns } from "./dns/cloudflare.js";

/**
 * DNS adapter selection. Kept separate from provider-adapter.js on purpose:
 * where a VPS runs (Hetzner, ...) and who serves its DNS name (Cloudflare,
 * ...) are independent choices, and fleet code must not assume they come
 * from the same vendor.
 */
const DNS_PROVIDERS = {
  cloudflare: createCloudflareDns,
};

export function getDnsAdapter(env) {
  const name = env.FLEET_DNS_PROVIDER ?? "cloudflare";
  const factory = DNS_PROVIDERS[name];
  if (!factory) throw new Error(`Unknown DNS provider: ${name}`);
  return factory(env);
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A node's public DNS name: `<nodeId>.<FLEET_NODE_DOMAIN>`, e.g.
 * de-fsn-001.nodes.example.com. Derived from the node id, never from the
 * customer-facing location -- several nodes share one location, and a
 * location can be renamed without renaming hosts.
 */
export function nodeHostname(nodeId, env) {
  const domain = (env.FLEET_NODE_DOMAIN ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!domain) throw new Error("FLEET_NODE_DOMAIN is not configured");
  if (!LABEL.test(nodeId)) throw new Error("nodeId is not a valid DNS label");
  return `${nodeId}.${domain}`;
}
