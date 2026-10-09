const CONNECT_SRC = "connect-src 'self' https://*.supabase.co";

export function apiOriginFrom(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`NEXT_PUBLIC_API_BASE_URL is not a valid URL: ${value}`); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must use https (http is allowed only for localhost)");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be an origin only, without path, query or credentials");
  }
  return url.origin;
}

export function addApiOrigin(headers, origin) {
  if (!origin) return headers;
  if (!headers.includes(CONNECT_SRC)) throw new Error("connect-src directive not found in _headers; cannot add the API origin");
  return headers.split(CONNECT_SRC).join(`${CONNECT_SRC} ${origin}`);
}
