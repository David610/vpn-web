import { clientCapabilities, protocolsForMode, supportsMode } from "./client-capabilities.js";

export class UnsupportedClientModeError extends Error {}
export { clientCapabilities };

function assertSupported(format, mode) {
  const capability = clientCapabilities()[format];
  if (!capability) throw new UnsupportedClientModeError("unsupported subscription format");
  if (!supportsMode(format, mode)) {
    throw new UnsupportedClientModeError(`${format} cannot represent Arcana ${mode === "privacy_plus" ? "Privacy+" : mode}`);
  }
  return protocolsForMode(format, mode);
}

function safeName(route) {
  return route.displayName.replace(/[\r\n#]/g, " ").trim();
}

function vlessLink(route, credential) {
  const q = new URLSearchParams({
    encryption: "none", security: "reality", sni: route.tlsServerName,
    fp: route.realityFingerprint || "chrome", pbk: route.realityPublicKey,
    sid: route.realityShortId, type: "tcp", flow: route.vlessFlow || "xtls-rprx-vision",
  });
  return `vless://${encodeURIComponent(credential.vless_uuid)}@${route.server}:${route.port}?${q}#${encodeURIComponent(safeName(route))}`;
}

function hysteriaLink(route, credential) {
  const q = new URLSearchParams({ sni: route.tlsServerName });
  if (route.hysteria2ObfsType) q.set("obfs", route.hysteria2ObfsType);
  if (route.hysteria2ObfsPassword) q.set("obfs-password", route.hysteria2ObfsPassword);
  return `hysteria2://${encodeURIComponent(credential.hysteria2_password)}@${route.server}:${route.port}?${q}#${encodeURIComponent(safeName(route))}`;
}

function linksFor(format, route, credential) {
  return assertSupported(format, route.mode).map((protocol) =>
    protocol === "vless" ? vlessLink(route, credential) : hysteriaLink(route, credential));
}

export function renderLinks(input) { return linksFor("links", input.route, input.credential).join("\n") + "\n"; }
export function renderHiddify(input) { return linksFor("hiddify", input.route, input.credential).join("\n") + "\n"; }
export function renderShadowrocket(input) { return linksFor("shadowrocket", input.route, input.credential).join("\n") + "\n"; }
export function renderIncy(input) { return linksFor("incy", input.route, input.credential).join("\n") + "\n"; }
export function renderXray(input) { return JSON.stringify({ version: 1, remarks: safeName(input.route), servers: linksFor("xray", input.route, input.credential) }, null, 2) + "\n"; }

/**
 * Privacy+ (two-hop) is refused here unconditionally, not just by the
 * `assertSupported` capability gate above. This function has no way to
 * build a correct two-hop config: a second, independently-scoped
 * credential for the entry hop (required per
 * docs/contracts/ARCANA_PRODUCT_V1.md §4b -- "Entry and exit use
 * independently scoped credential material") is not modeled anywhere in
 * this data path. `compatibility_credentials` holds one credential per
 * device for rotation, not one per hop, and this function's only input is
 * a single `credential`.
 *
 * An earlier version of this function built an `outbounds` array with a
 * `detour`-chained entry hop assembled by spreading `route.entry`'s flat
 * fields directly as an outbound object -- which is missing `type`,
 * `server_port` (it had `port`), and a full `tls` block, and carries no
 * credential at all for that hop. It only ever looked complete because the
 * capability gate made it unreachable. Caught during the investigation for
 * reconciling `vpn-web`'s Links feature with `singbox-vpn`'s own, separate
 * and real-device-verified two-hop `detour` mechanism (see
 * ARCANA_PRODUCT_V1.md §10) -- that mechanism is sound in principle, but
 * this specific implementation never carried it out correctly, and silently
 * shipping it on a future capability-gate flip would serve a broken,
 * unauthenticated entry hop to a paying customer. Building it correctly is
 * its own scoped follow-up: it needs a second credential issued and stored
 * per two-hop device, not a local fix to this function alone.
 */
export function renderSingBox({ route, credential }) {
  assertSupported("singbox", route.mode);
  if (route.mode === "privacy_plus") {
    throw new UnsupportedClientModeError(
      "singbox cannot represent Arcana Privacy+ yet -- no per-hop credential model exists for compatibility clients"
    );
  }
  const exitTag = safeName(route);
  const outbound = {
    type: "vless", tag: exitTag, server: route.server, server_port: route.port,
    uuid: credential.vless_uuid, flow: route.vlessFlow || "xtls-rprx-vision",
    tls: { enabled: true, server_name: route.tlsServerName, reality: { enabled: true, public_key: route.realityPublicKey, short_id: route.realityShortId }, utls: { enabled: true, fingerprint: route.realityFingerprint || "chrome" } },
  };
  return JSON.stringify({ log: { level: "warn" }, outbounds: [outbound], route: { final: exitTag } }, null, 2) + "\n";
}

export const renderers = Object.freeze({ hiddify: renderHiddify, shadowrocket: renderShadowrocket, incy: renderIncy, singbox: renderSingBox, xray: renderXray, links: renderLinks });
