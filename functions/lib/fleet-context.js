import { getProviderAdapter } from "./provider-adapter.js";
import { getDnsAdapter } from "./dns-adapter.js";
import { probeNodeReadiness } from "./node-probe.js";
import { sha256Hex } from "./crypto.js";

/** Production wiring for fleet-operations.js's advanceOperation(). */
export function fleetContext(supabase, env) {
  return {
    supabase,
    env,
    providers: getProviderAdapter,
    dns: getDnsAdapter,
    probe: probeNodeReadiness,
  };
}

/**
 * Constant-time check of the reconciler's shared secret. Both sides are
 * hashed first so the comparison length never depends on the input.
 */
export async function isValidFleetTickSecret(presented, expected) {
  if (!expected || typeof presented !== "string" || !presented) return false;
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
