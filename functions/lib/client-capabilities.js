const CAPABILITIES = Object.freeze({
  hiddify: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  shadowrocket: Object.freeze({ fast: Object.freeze(["vless", "hysteria2"]), privacy_plus: Object.freeze([]) }),
  incy: Object.freeze({ fast: Object.freeze(["vless"]), privacy_plus: Object.freeze([]) }),
  // Privacy+ stays fail-closed until Arcana's exact two-hop topology has been
  // qualified. Supporting a client's detour syntax is not sufficient.
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
