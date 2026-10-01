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
  return hmacSha256Hex(token, env.SUBSCRIPTION_TOKEN_HASH_KEY);
}

export async function rateLimitKeyHash(value, env) {
  // Keep rate-limit identifiers in a separate HMAC domain without changing
  // the deployed subscription-token lookup digest format.
  return hmacSha256Hex("arcana:rate-limit:v1:" + value, env.SUBSCRIPTION_TOKEN_HASH_KEY);
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