const base = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return base && path.startsWith("/") ? `${base}${path}` : path;
}

/** Host that serves VPN links: the API host when it is separate, otherwise this site. */
export function linkHost(): string {
  if (base) return new URL(base).host;
  return typeof window === "undefined" ? "arcana" : window.location.host;
}
