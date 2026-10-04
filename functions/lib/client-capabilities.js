const CAPABILITIES = Object.freeze({
  // hiddify/shadowrocket/incy/links/xray render bare connection URIs
  // (vless://, hysteria2://) -- a single-endpoint format with no mechanism
  // to express a second hop at all. Privacy+ can never be representable
  // for these without changing the format itself, not just a policy
  // decision -- this is a structural limitation, not a qualification gap.
  hiddify: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  shadowrocket: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  incy: Object.freeze({ fast: Object.freeze(["vless"]), privacy_plus: Object.freeze([]) }),
  // singbox's format (a real sing-box JSON config) COULD express Privacy+
  // via sing-box's own `detour` outbound-chaining -- singbox-vpn's own,
  // separate Rust renderer already proves that mechanism end-to-end with a
  // real sing-box binary over real two-provider infrastructure (see
  // singbox-vpn/docs/DEVICE_ACCEPTANCE_TESTS.md, 2026-09-22 entry). But
  // THIS renderer (subscription-renderers.js's renderSingBox) cannot build
  // it correctly today: it has no per-hop credential model -- only one
  // credential is ever issued/fetched per compatibility device, and a real
  // two-hop relay needs an independently-scoped credential for the entry
  // hop too (ARCANA_PRODUCT_V1.md §4b). renderSingBox refuses Privacy+ on
  // its own even if this flag were flipped (see its own comment) --
  // fixing this for real needs a second, per-hop credential issued and
  // stored, which is scoped follow-up work, not a flag flip.
  singbox: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  xray: Object.freeze({ fast: Object.freeze(["vless"]), privacy_plus: Object.freeze([]) }),
  links: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
});

export function clientCapabilities() {
  return CAPABILITIES;
}

export function isSupportedClient(clientType) {
  return Object.hasOwn(CAPABILITIES, clientType);
}

export function protocolsForMode(clientType, mode) {
  return CAPABILITIES[clientType]?.[mode] ?? [];
}

export function supportsMode(clientType, mode) {
  return protocolsForMode(clientType, mode).length > 0;
}
