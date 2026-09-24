/**
 * Node enrollment tokens and node API keys share one shape: 32 random
 * bytes, hex-encoded -- the same format scripts/register-node.mjs has
 * always used for api_key_hash's raw key, and the same "only the hash is
 * ever stored, plaintext exists exactly once in the response" discipline
 * as invite tokens (functions/lib/invite-token.js).
 */
export function generateHexSecret(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Short-lived by design (spec §20): long enough for an operator to paste
// the token into cloud-init/a bootstrap script and have the VPS boot and
// call functions/api/agent/enroll.js, short enough that a token leaked
// from a build log or shell history stops being useful quickly.
export const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;
