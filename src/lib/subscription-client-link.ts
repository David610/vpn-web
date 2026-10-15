/**
 * Pick the subscription representation that a customer's external client
 * expects. Only the response format changes; the bearer token and origin
 * remain identical. Do not persist or log these URLs.
 */
export type SubscriptionClient = "links" | "hiddify" | "shadowrocket" | "incy" | "singbox";

export const SUBSCRIPTION_CLIENTS: readonly { value: SubscriptionClient; label: string }[] = [
  { value: "links", label: "Other compatible client (share links)" },
  { value: "hiddify", label: "Hiddify" },
  { value: "shadowrocket", label: "Shadowrocket" },
  { value: "incy", label: "INCY (VLESS)" },
  { value: "singbox", label: "sing-box (JSON)" },
];

/** For render paths: a link that cannot be converted must never crash the page. */
export function tryClientSubscription(accessUrl: string, client: SubscriptionClient): string | null {
  try {
    return subscriptionForClient(accessUrl, client);
  } catch {
    return null;
  }
}

export function subscriptionForClient(accessUrl: string, client: SubscriptionClient): string {
  const url = new URL(accessUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Subscription URL must use HTTPS.");
  }
  if (!/^\/sub\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
    throw new Error("Unrecognized subscription URL.");
  }
  url.searchParams.set("format", client);
  url.searchParams.delete("encoding");
  if (client === "shadowrocket") url.searchParams.set("encoding", "base64");
  return url.toString();
}
