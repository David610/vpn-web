// AES-GCM encrypt/decrypt for vpn_secrets.ciphertext/nonce, and sha256
// hex for node API key verification. Uses the Workers runtime's native
// Web Crypto (crypto.subtle) — no extra dependency.
//
// vpn_secrets.ciphertext/nonce are Postgres bytea columns. PostgREST
// represents bytea as a "\x"-prefixed hex string over the wire, on both
// read and write — every function here works in that representation, not
// base64 or raw ArrayBuffer, or writes would silently corrupt the column.

function hexToBytes(hex) {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToPgHex(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `\\x${hex}`;
}

async function importAesKey(keyHex) {
  const keyBytes = hexToBytes(keyHex);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * @param {string} plaintext
 * @param {string} keyHex - 64-hex-char (256-bit) VPN_SECRETS_ENCRYPTION_KEY
 * @returns {Promise<{ ciphertext: string, nonce: string }>} both as
 *   Postgres-bytea-compatible "\x..." hex strings, ready to insert
 *   directly into vpn_secrets.
 */
export async function encryptSecret(plaintext, keyHex) {
  const key = await importAesKey(keyHex);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: bytesToPgHex(new Uint8Array(ciphertextBuf)),
    nonce: bytesToPgHex(nonce),
  };
}

/**
 * @param {string} ciphertextHex - "\x..."-prefixed hex, as read back from vpn_secrets
 * @param {string} nonceHex - "\x..."-prefixed hex, as read back from vpn_secrets
 * @param {string} keyHex - 64-hex-char (256-bit) VPN_SECRETS_ENCRYPTION_KEY
 * @returns {Promise<string>} the decrypted plaintext
 */
export async function decryptSecret(ciphertextHex, nonceHex, keyHex) {
  const key = await importAesKey(keyHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const nonce = hexToBytes(nonceHex);
  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}

/**
 * @param {string} text
 * @returns {Promise<string>} lowercase hex sha256 digest, no "\x" prefix
 *   (this is a lookup key, not a bytea column value).
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
