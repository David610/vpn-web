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

function vlessOutbound(tag, route, vlessUuid) {
  return {
    type: "vless", tag, server: route.server, server_port: route.port,
    uuid: vlessUuid, flow: route.vlessFlow || "xtls-rprx-vision",
    tls: { enabled: true, server_name: route.tlsServerName, reality: { enabled: true, public_key: route.realityPublicKey, short_id: route.realityShortId }, utls: { enabled: true, fingerprint: route.realityFingerprint || "chrome" } },
  };
}

/**
 * Privacy+ (two-hop) via sing-box's own `detour` outbound chaining --
 * entry hop first, `detour`-ed into by the exit hop, `route.final` pointed
 * at the exit's own tag so nothing else is reachable. This is the same
 * mechanism `singbox-vpn` proves end-to-end against a real binary over
 * real two-provider infrastructure (see ARCANA_PRODUCT_V1.md §10).
 *
 * `route.entry` must carry its OWN independently-scoped `vlessUuid` (per
 * §4b) alongside the entry node's public material -- an earlier version of
 * this function instead spread `route.entry`'s flat fields directly as an
 * outbound object, which produced a malformed, uncredentialed entry hop
 * that only looked complete because the capability gate (still closed
 * today -- see client-capabilities.js) made it unreachable. Fixed as part
 * of also fixing the credential-issuance side that was supposed to supply
 * `vlessUuid` (ARCANA_LINKS_V1.md's "Route compatibility" section).
 * Refusing explicitly when it's still missing, rather than building a
 * partial chain, is deliberate defense in depth independent of that gate.
 */
export function renderSingBox({ route, credential }) {
  assertSupported("singbox", route.mode);
  const exitTag = safeName(route);
  const outbound = vlessOutbound(exitTag, route, credential.vless_uuid);
  if (route.mode === "privacy_plus") {
    if (!route.entry?.vlessUuid) {
      throw new UnsupportedClientModeError("Privacy+ route topology is incomplete -- missing entry hop credential");
    }
    outbound.detour = "arcana-entry";
    const entryOutbound = vlessOutbound("arcana-entry", route.entry, route.entry.vlessUuid);
    return JSON.stringify({ log: { level: "warn" }, outbounds: [entryOutbound, outbound], route: { final: exitTag } }, null, 2) + "\n";
  }
  return JSON.stringify({ log: { level: "warn" }, outbounds: [outbound], route: { final: exitTag } }, null, 2) + "\n";
}

export const renderers = Object.freeze({ hiddify: renderHiddify, shadowrocket: renderShadowrocket, incy: renderIncy, singbox: renderSingBox, xray: renderXray, links: renderLinks });
