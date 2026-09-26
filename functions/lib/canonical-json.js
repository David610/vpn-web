/**
 * Byte-for-byte port of tamara-next's _canonicalJson
 * (lib/infrastructure/control_plane/signed_route_directory.dart): sort
 * object keys recursively, encode each leaf with the platform's own JSON
 * string/number/bool/null encoder, no whitespace. The Ed25519 signature
 * in GET /v1/routes' envelope covers exactly this string's UTF-8 bytes,
 * so any divergence from Dart's own output here breaks every client's
 * ability to verify a real signature -- this file has no behavior of its
 * own to get right beyond matching that algorithm exactly.
 *
 * Every value passed to this function must contain only integers (never
 * floats) in its numeric fields -- JSON.stringify and Dart's num
 * formatting are not guaranteed to agree on float representation, and
 * nothing in this codebase's signed envelope needs a float.
 */
export function canonicalJsonString(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`).join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  return JSON.stringify(value);
}
