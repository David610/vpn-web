/**
 * Short-lived, single-use linking codes: generated on the authenticated
 * web dashboard, then supplied by the customer to the Mini App (which
 * proves Telegram identity via initData) to bind the two accounts.
 *
 * Same "store only the hash" discipline as invite-token.js, but shorter
 * and alphanumeric -- a customer may need to type this into the bot by
 * hand, unlike an invite link's URL-embedded token.
 */

import { sha256Hex } from "./crypto.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 8;
export const LINK_CODE_TTL_SECONDS = 10 * 60;

export function generateLinkCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function hashLinkCode(code) {
  return sha256Hex(code.toUpperCase());
}
