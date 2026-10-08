export type VpnLink = {
  id: string;
  name: string;
  configurationFamily: string;
  routeId: string;
  routeLabel?: string;
  locationMode: "auto" | "manual";
  privacyClass: "fast" | "privacy_plus" | null;
  maxClients: number;
  clientCount: number;
  primaryClientId: string | null;
  status: string;
  createdAt: string;
  revokedAt: string | null;
};

export type LinkClient = {
  id: string;
  linkId: string;
  name: string;
  clientType: string;
  routeId: string;
  lastSeenAt: string | null;
  status: string;
  revokedAt: string | null;
  createdAt: string;
};

export type RouteOption = { id: string; display_name: string; region: string; privacy_class: "fast" | "privacy_plus" | string };

export type Routing = "one" | "two";
export type LocationChoice = "auto" | "manual";

export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function routingOf(route: Pick<RouteOption, "privacy_class"> | undefined): Routing {
  return route?.privacy_class === "privacy_plus" ? "two" : "one";
}

export function routingLabel(routing: Routing) {
  return routing === "two" ? "2 servers" : "1 server";
}

export function locationLabel(mode: LocationChoice) {
  return mode === "auto" ? "Automatic" : "Manual";
}

/** "1 server · Automatic" — the one-line configuration summary. */
export function configurationSummary(link: Pick<VpnLink, "locationMode" | "privacyClass">) {
  return `${routingLabel(routingOf({ privacy_class: link.privacyClass ?? "fast" }))} · ${locationLabel(link.locationMode)}`;
}

export function configurationDetail(link: Pick<VpnLink, "locationMode" | "routeLabel">) {
  return link.locationMode === "auto"
    ? link.routeLabel
      ? `Location selected automatically: ${link.routeLabel}`
      : "Location selected automatically"
    : link.routeLabel ?? "Chosen location";
}

/** A random pick spreads automatic Links across locations instead of piling onto one. */
export function pickAutomaticRoute(routes: RouteOption[]): RouteOption | null {
  if (routes.length === 0) return null;
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return routes[buffer[0] % routes.length];
}
