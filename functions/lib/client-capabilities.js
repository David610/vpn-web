const CAPABILITIES = Object.freeze({
  // hiddify/shadowrocket/incy/links/xray render bare connection URIs
  // (vless://, hysteria2://) -- a single-endpoint format with no mechanism
  // to express a second hop at all. Privacy+ can never be representable
  // for these without changing the format itself, not just a policy
  // decision -- this is a structural limitation, not a qualification gap.
  hiddify: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  shadowrocket: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  incy: Object.freeze({ fast: Object.freeze(["vless"]), privacy_plus: Object.freeze([]) }),
  // singbox's format (a real sing-box JSON config) expresses Privacy+ via
  // sing-box's own `detour` outbound-chaining -- the same mechanism
  // singbox-vpn's own, separate Rust renderer proves end-to-end with a
  // real sing-box binary over real two-provider infrastructure (see
  // singbox-vpn/docs/DEVICE_ACCEPTANCE_TESTS.md, 2026-09-22 entry).
  // renderSingBox now builds a correct two-hop config, and the per-hop
  // credential model exists end-to-end (compatibility_credentials.hop,
  // create_external_vpn_device/rotate_compatibility_credential's
  // p_credentials -- see supabase/migrations/
  // 20261015000000_compatibility_two_hop_credentials.sql) and is covered
  // by SQL + unit tests. This flag stays closed anyway: nothing has yet
  // verified real sing-box-based compat clients actually honor the
  // rendered `detour` chain against this specific pipeline's real,
  // deployed node infrastructure, as opposed to singbox-vpn's own proven
  // (but separate) implementation. Flip deliberately, not as a side
  // effect of another change, once that verification exists.
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
