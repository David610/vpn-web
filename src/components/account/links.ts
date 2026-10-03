export type VpnLink = {
  id: string;
  name: string;
  configurationFamily: string;
  routeId: string;
  maxClients: number;
  clientCount: number;
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

export type RouteOption = { id: string; display_name: string; region: string; privacy_class: string };

export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
