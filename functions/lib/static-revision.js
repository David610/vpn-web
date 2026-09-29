/**
 * Static-config node revisions (revision_schema 1) -- control-plane half of
 * the contract enforced node-side by singbox-vpn's
 * crates/compat-config/src/static_revision.rs.
 *
 * A node revision's `config` is either a users-store snapshot (the existing
 * dynamic revision shape) or, when it carries `revision_schema` /
 * `static_config`, a static-config revision:
 *
 *   { "revision_schema": 1,
 *     "static_config": { "reality":   { "handshake_server": "..." },
 *                        "hysteria2": { "up_mbps": N, "down_mbps": N },
 *                        "udp_probe": { "ipv4_resolvers": [...], ... } } }
 *
 * Only the allowlisted fields below may be sent. Node identity, role, trust
 * root, install paths and public network identity are forbidden (changing
 * them is a privileged reprovision, never a routine revision); listener
 * ports are recognized but deferred. Anything unknown rejects the WHOLE
 * document -- nothing is silently dropped. The node re-validates
 * independently; this check exists so an invalid revision is refused at
 * creation time instead of becoming desired state that can never converge.
 *
 * Keep in lock-step with the Rust side: both repos assert the same fixture
 * (__tests__/fixtures/static-revision-v1-contract.json).
 */

export const STATIC_REVISION_SCHEMA = 1;
export const MAX_STATIC_REVISION_BYTES = 16 * 1024;

export const ALLOWED_FIELDS = Object.freeze({
  reality: ["handshake_server"],
  hysteria2: ["up_mbps", "down_mbps"],
  udp_probe: ["ipv4_resolvers", "ipv6_resolvers", "retries", "timeout_ms", "delay_ms"],
});

export const FORBIDDEN_TOP_LEVEL_FIELDS = Object.freeze([
  "schema_version",
  "node_id",
  "role",
  "public_host",
  "subscription_host",
  "public_ipv4",
  "public_ipv6",
  "state_dir",
  "singbox_binary",
  "access_paths",
  "peer_endpoints",
  "google_egress_hairpin",
  "subscription",
]);

export const DEFERRED_SECTION_FIELDS = Object.freeze({
  reality: ["listen_port", "handshake_port"],
  hysteria2: ["listen_port"],
});

const MAX_RESOLVERS_PER_FAMILY = 8;
const MAX_MBPS = 100000;
const LOCAL_SUFFIXES = new Set([
  "localhost", "local", "internal", "lan", "home", "corp", "intranet",
  "localdomain", "arpa", "test", "invalid", "example",
]);

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Routing check mirroring the node: presence of either key makes it static. */
export function isStaticRevisionConfig(config) {
  return isPlainObject(config) && (own(config, "revision_schema") || own(config, "static_config"));
}

class StaticRevisionError extends Error {}
const fail = (msg) => {
  throw new StaticRevisionError(`static revision rejected: ${msg}`);
};

function bounded(v, name, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer in ${min}..=${max}`);
  return v;
}

function parseIpv4(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^(0|[1-9][0-9]{0,2})$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => Number.isInteger(o) && o <= 255) ? octets : null;
}

function publicIpv4(o) {
  return !(
    o[0] === 127 || o[0] === 10 || o[0] === 0 || o[0] >= 224 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 169 && o[1] === 254) ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
    (o[0] === 198 && (o[1] === 18 || o[1] === 19)) ||
    (o[0] === 192 && o[1] === 0 && o[2] === 2) ||
    (o[0] === 198 && o[1] === 51 && o[2] === 100) ||
    (o[0] === 203 && o[1] === 0 && o[2] === 113)
  );
}

/** Expands an IPv6 literal to 8 hextets (with trailing dotted-quad support), or null. */
function parseIpv6(s) {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(":")) return null;
  let tail = [];
  let head = s;
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = s.slice(0, lastColon + 1) + "0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h) => (h === "" ? [] : h.split(":"));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  if (tail.length) (halves.length === 2 ? right : left).pop();
  const groups = [...left, ...right].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some(Number.isNaN)) return null;
  const known = groups.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    const zeros = new Array(8 - known).fill(0);
    const l = left.length;
    const all = [...groups.slice(0, l), ...zeros, ...groups.slice(l), ...tail];
    return all;
  }
  return known === 8 ? [...groups, ...tail] : null;
}

function publicIpv6(h) {
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return publicIpv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }
  const allZeroBut = (last) => h.slice(0, 7).every((x) => x === 0) && h[7] === last;
  return !(
    allZeroBut(0) || allZeroBut(1) ||
    (h[0] & 0xff00) === 0xff00 ||
    (h[0] & 0xfe00) === 0xfc00 ||
    (h[0] & 0xffc0) === 0xfe80 ||
    (h[0] === 0x2001 && h[1] === 0x0db8)
  );
}

function resolvers(v, name, ipv6) {
  if (!Array.isArray(v)) fail(`udp_probe.${name} must be an array of IP literals`);
  if (v.length > MAX_RESOLVERS_PER_FAMILY || (!ipv6 && v.length === 0)) {
    fail(`udp_probe.${name} must have ${ipv6 ? 0 : 1}..=${MAX_RESOLVERS_PER_FAMILY} entries`);
  }
  const seen = new Set();
  for (const s of v) {
    if (typeof s !== "string") fail(`udp_probe.${name} entries must be strings`);
    const v4 = parseIpv4(s);
    const v6 = v4 ? null : parseIpv6(s);
    if (!v4 && !v6) fail(`udp_probe.${name}: ${JSON.stringify(s)} is not an IP literal`);
    if (Boolean(v6) !== ipv6) fail(`udp_probe.${name}: ${JSON.stringify(s)} is the wrong address family`);
    if (v4 ? !publicIpv4(v4) : !publicIpv6(v6)) {
      fail(`udp_probe.${name}: ${JSON.stringify(s)} is not a public unicast address`);
    }
    const key = (v4 ?? v6).join(",");
    if (seen.has(key)) fail(`udp_probe.${name}: duplicate entry ${JSON.stringify(s)}`);
    seen.add(key);
  }
}

export function validateHandshakeServer(host) {
  const bad = (why) => fail(`reality.handshake_server ${JSON.stringify(host)} ${why}`);
  if (typeof host !== "string") bad("must be a string");
  if (host.length === 0 || host.length > 253) bad("must be 1..=253 characters");
  if (parseIpv4(host) || parseIpv6(host) || host.startsWith("[")) bad("must be a public DNS name, not an IP literal");
  const labels = host.split(".");
  if (labels.length < 2) bad("must be a fully-qualified DNS name");
  for (const label of labels) {
    if (!/^[a-z0-9-]{1,63}$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      bad("is not a lowercase DNS name");
    }
  }
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld)) bad("must be a public DNS name, not an IP literal");
  if (LOCAL_SUFFIXES.has(tld)) bad("uses a local/reserved suffix");
}

/**
 * Validates a static revision config. Returns { ok: true } or
 * { ok: false, error }. Never throws.
 */
export function validateStaticRevisionConfig(config) {
  try {
    const size = new TextEncoder().encode(JSON.stringify(config)).length;
    if (size > MAX_STATIC_REVISION_BYTES) fail(`document is ${size} bytes, over the ${MAX_STATIC_REVISION_BYTES}-byte limit`);
    if (!isPlainObject(config)) fail("document must be a JSON object");
    for (const key of Object.keys(config)) {
      if (key !== "revision_schema" && key !== "static_config") fail(`unknown top-level key ${JSON.stringify(key)}`);
    }
    const schema = config.revision_schema;
    if (!Number.isInteger(schema)) fail("missing or non-integer revision_schema");
    if (schema !== STATIC_REVISION_SCHEMA) fail(`unsupported revision_schema ${schema}`);
    const sc = config.static_config;
    if (!isPlainObject(sc)) fail("missing static_config object");
    if (Object.keys(sc).length === 0) fail("static_config is empty");

    for (const [section, body] of Object.entries(sc)) {
      if (FORBIDDEN_TOP_LEVEL_FIELDS.includes(section)) {
        fail(`${JSON.stringify(section)} is a security-sensitive field and cannot be changed by a routine static revision; it requires a privileged reprovision`);
      }
      if (!own(ALLOWED_FIELDS, section)) fail(`unknown static_config section ${JSON.stringify(section)}`);
      if (!isPlainObject(body)) fail(`static_config.${section} must be an object`);
      if (Object.keys(body).length === 0) fail(`static_config.${section} is empty`);
      for (const field of Object.keys(body)) {
        if ((DEFERRED_SECTION_FIELDS[section] ?? []).includes(field)) {
          fail(`${section}.${field} is not routinely revisable in revision_schema 1`);
        }
        if (!ALLOWED_FIELDS[section].includes(field)) fail(`unknown field ${section}.${field}`);
      }
    }

    if (sc.reality && own(sc.reality, "handshake_server")) validateHandshakeServer(sc.reality.handshake_server);

    if (sc.hysteria2) {
      const hasUp = own(sc.hysteria2, "up_mbps");
      const hasDown = own(sc.hysteria2, "down_mbps");
      if (hasUp !== hasDown) fail("hysteria2.up_mbps and hysteria2.down_mbps must be sent together");
      const { up_mbps: up, down_mbps: down } = sc.hysteria2;
      if (!(up === null && down === null)) {
        if (up === null || down === null) fail("hysteria2.up_mbps and hysteria2.down_mbps must be sent together");
        bounded(up, "hysteria2.up_mbps", 1, MAX_MBPS);
        bounded(down, "hysteria2.down_mbps", 1, MAX_MBPS);
      }
    }

    const udp = sc.udp_probe;
    if (udp) {
      if (own(udp, "ipv4_resolvers")) resolvers(udp.ipv4_resolvers, "ipv4_resolvers", false);
      if (own(udp, "ipv6_resolvers")) resolvers(udp.ipv6_resolvers, "ipv6_resolvers", true);
      if (own(udp, "retries")) bounded(udp.retries, "udp_probe.retries", 1, 10);
      if (own(udp, "timeout_ms")) bounded(udp.timeout_ms, "udp_probe.timeout_ms", 100, 30000);
      if (own(udp, "delay_ms")) bounded(udp.delay_ms, "udp_probe.delay_ms", 0, 10000);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof StaticRevisionError) return { ok: false, error: err.message };
    return { ok: false, error: "static revision rejected: malformed document" };
  }
}
