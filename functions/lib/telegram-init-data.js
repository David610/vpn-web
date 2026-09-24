// Verification of Telegram Mini App `initData` payloads, per Telegram's
// documented algorithm:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
//   secret_key = HMAC_SHA256(key="WebAppData", data=<bot_token>)
//   data_check_string = every field except "hash", sorted by key ascending,
//                        joined as "key=value" pairs with "\n"
//   computed_hash = HMAC_SHA256(key=secret_key, data=data_check_string), hex
//
// A caller is authentic iff computed_hash constant-time-equals the "hash"
// field, AND auth_date is recent (Telegram signs initData once per Mini
// App open; without a freshness check a leaked/logged initData string
// would be a permanent bearer credential instead of a short-lived one).
//
// Deliberately mirrors this repo's existing signature-verification shape
// (functions/lib/crypto.js's sha256Hex, functions/lib/node-auth.js's
// hash-then-compare) rather than inventing a new scheme.

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

function hex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, messageBytes);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {string} initData - the raw, unparsed query-string the Mini App
 *   client hands back (`window.Telegram.WebApp.initData`).
 * @param {string} botToken - env.TELEGRAM_BOT_TOKEN. Never logged.
 * @param {number} [maxAgeSeconds]
 * @returns {Promise<
 *   | { ok: true, user: { id: number, username: string|null, firstName: string|null, lastName: string|null }, authDate: number }
 *   | { ok: false, reason: string }
 * >}
 */
export async function verifyTelegramInitData(
  initData,
  botToken,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS
) {
  if (typeof initData !== "string" || initData.length === 0) {
    return { ok: false, reason: "missing initData" };
  }
  if (typeof botToken !== "string" || botToken.length === 0) {
    return { ok: false, reason: "server not configured for Telegram" };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed initData" };
  }

  const providedHash = params.get("hash");
  if (!providedHash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), encoder.encode(botToken));
  const computedHashBytes = await hmacSha256(new Uint8Array(secretKey), encoder.encode(dataCheckString));
  const computedHash = hex(computedHashBytes);

  // Constant-time comparison on the hex strings -- length-equal by
  // construction (both are 64-char sha256 hex) once we've confirmed
  // providedHash is well-formed, but never assume: compare lengths first.
  if (!constantTimeEqual(computedHash, providedHash.toLowerCase())) {
    return { ok: false, reason: "invalid signature" };
  }

  const authDateRaw = params.get("auth_date");
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: "missing or invalid auth_date" };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > 60) {
    // Reject both stale payloads and ones improbably far in the future
    // (clock skew tolerance of 60s, matching how the rest of this codebase
    // treats server-issued timestamps as authoritative).
    return { ok: false, reason: "stale auth_date" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing user field" };
  let userJson;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "malformed user field" };
  }
  if (typeof userJson?.id !== "number") {
    return { ok: false, reason: "malformed user field" };
  }

  return {
    ok: true,
    authDate,
    user: {
      id: userJson.id,
      username: typeof userJson.username === "string" ? userJson.username : null,
      firstName: typeof userJson.first_name === "string" ? userJson.first_name : null,
      lastName: typeof userJson.last_name === "string" ? userJson.last_name : null,
    },
  };
}

export { DEFAULT_MAX_AGE_SECONDS };
