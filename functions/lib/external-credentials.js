import { encryptSecret, hmacSha256Hex, randomBase64Url } from "./crypto.js";

export const COMPATIBILITY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const COMPATIBILITY_OVERLAP_MS = 48 * 60 * 60 * 1000;

export function newOpaqueId(prefix) {
  return `${prefix}_${randomBase64Url(32)}`;
}

export function newSubscriptionToken() {
  return randomBase64Url(32);
}

export async function subscriptionTokenHash(token, env) {
  return hmacSha256Hex(`subscription-token:v1:${token}`, env.SUBSCRIPTION_TOKEN_HASH_KEY);
}

// Read-only compatibility for tokens issued before domain separation. New
// tokens are never written with this derivation and may be removed after the
// longest configured subscription-token lifetime has elapsed.
export async function legacySubscriptionTokenHash(token, env) {
  return hmacSha256Hex(token, env.SUBSCRIPTION_TOKEN_HASH_KEY);
}

export async function rateLimitIpHash(ipKey, env) {
  return hmacSha256Hex(`rate-limit-ip:v1:${ipKey}`, env.SUBSCRIPTION_TOKEN_HASH_KEY);
}

export async function newProtocolCredential(env) {
  const material = {
    vless_uuid: crypto.randomUUID(),
    hysteria2_password: randomBase64Url(32),
  };
  return { material, ...(await encryptSecret(JSON.stringify(material), env.VPN_SECRETS_ENCRYPTION_KEY)) };
}

export function subscriptionUrl(request, token, format) {
  const origin = new URL(request.url).origin;
  return `${origin}/sub/${encodeURIComponent(token)}?format=${encodeURIComponent(format)}`;
}
