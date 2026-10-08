// SITE_URL is a placeholder until a real domain is purchased (tracked as a
// prerequisite in the spec, not decided yet). This is the ONLY place a
// domain may be hardcoded — everything else (metadata, canonical links,
// OG tags in later tasks) imports it from here.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://arcana.example";
export const SITE_NAME = "Arcana";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";

// SUPPORT_EMAIL is a placeholder until a real support mailbox exists. This
// is the ONLY place it may be hardcoded — scripts/check-production-config.mjs
// refuses a production deploy while this still resolves to the placeholder.
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@arcana.example";

// Subscription terms shown on public pages. Billing and capacity are enforced
// server-side; these only drive copy.
export const PLAN_PRICE_LABEL = "€6.99";
export const PLAN_DEVICES = 3;

// Two-server (Privacy+) Links are only offered once the backend can render a
// second hop for third-party clients (see functions/lib/client-capabilities.js,
// where every client currently lists no privacy_plus protocols). Flip this
// together with that table so marketing never promises what a Link cannot do.
export const TWO_SERVER_LINKS = false;

// Optional badge shown in the admin header ("Staging", "Development", ...) so
// an admin always knows which environment they are acting on. Empty in production.
export const ENV_LABEL = process.env.NEXT_PUBLIC_ENV_LABEL || "";
