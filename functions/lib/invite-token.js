/**
 * Invite tokens, handled the same way singbox-vpn handles subscription
 * tokens: 160 bits of entropy, and only the SHA-256 hash is ever stored.
 *
 * The plaintext exists in exactly two places — the invite email, and the
 * accept request that spends it. A dump of member_invites therefore hands
 * the reader nothing usable, which matters because accepting an invite
 * grants access to a paid plan.
 */

const TOKEN_BYTES = 20; // 160 bits

/** URL-safe base64 without padding, so the token drops into a link as-is. */
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateInviteToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function hashInviteToken(token) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
