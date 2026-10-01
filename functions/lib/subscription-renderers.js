const CAPABILITIES = Object.freeze({
  hiddify: { fast: ["vless", "hysteria2"], privacy_plus: [] },
  shadowrocket: { fast: ["vless", "hysteria2"], privacy_plus: [] },
  incy: { fast: ["vless"], privacy_plus: [] },
  // Privacy+ remains fail-closed until the pinned Phase-1 nested/detour
  // fixture can be validated cross-repository. Supporting detour syntax in
  // theory is not qualification of Arcana's exact two-hop topology.
  singbox: { fast: ["vless", "hysteria2"], privacy_plus: [] },
  xray: { fast: ["vless"], privacy_plus: [] },
  links: { fast: ["vless", "hysteria2"], privacy_plus: [] },
});

export class UnsupportedClientModeError extends Error {}
export const clientCapabilities = () => CAPABILITIES;
export const supportedClientTypes = () => Object.keys(CAPABILITIES);
export const supportsMode = (format, mode) => Boolean(CAPABILITIES[format]?.[mode]?.length);

function assertSupported(format, mode) {
  const capability = CAPABILITIES[format];
  if (!capability) throw new UnsupportedClientModeError("unsupported subscription format");
  if (!supportsMode(format, mode)) {
    throw new UnsupportedClientModeError(`${format} cannot represent Arcana ${mode === "privacy_plus" ? "Privacy+" : mode}`);
  }
  return capability[mode];
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
export function renderSingBox({ route, credential }) {
  assertSupported("singbox", route.mode);
  const exitTag = safeName(route);
  const outbound = {
    type: "vless", tag: exitTag, server: route.server, server_port: route.port,
    uuid: credential.vless_uuid, flow: route.vlessFlow || "xtls-rprx-vision",
    tls: { enabled: true, server_name: route.tlsServerName, reality: { enabled: true, public_key: route.realityPublicKey, short_id: route.realityShortId }, utls: { enabled: true, fingerprint: route.realityFingerprint || "chrome" } },
  };
  if (route.mode === "privacy_plus") {
    if (!route.entry) throw new UnsupportedClientModeError("Privacy+ route topology is incomplete");
    outbound.detour = "arcana-entry";
  }
  const outbounds = route.entry ? [{ ...route.entry, tag: "arcana-entry" }, outbound] : [outbound];
  return JSON.stringify({ log: { level: "warn" }, outbounds, route: { final: exitTag } }, null, 2) + "\n";
}

export const renderers = Object.freeze({ hiddify: renderHiddify, shadowrocket: renderShadowrocket, incy: renderIncy, singbox: renderSingBox, xray: renderXray, links: renderLinks });