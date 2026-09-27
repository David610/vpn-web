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
