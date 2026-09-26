import { requireAdmin } from "../../lib/admin-auth.js";
import { createClient } from "@supabase/supabase-js";
import { configPresence } from "../../lib/admin-fleet.js";
import { BASE_PRICE_CENTS, DEVICE_PACK_SIZE, INCLUDED_DEVICES, PACK_PRICE_CENTS } from "../../lib/seat-constants.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const set = (value) => typeof value === "string" && value.length > 0;

/**
 * Read-only platform configuration for the admin Settings page: which
 * integrations are configured and the plan constants. Never returns a
 * secret or key value — only whether one is present.
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  return jsonResponse({
    plan: {
      includedDevices: INCLUDED_DEVICES,
      devicesPerPack: DEVICE_PACK_SIZE,
      basePriceCents: BASE_PRICE_CENTS,
      packPriceCents: PACK_PRICE_CENTS,
      currency: "EUR",
    },
    billing: {
      stripeApiKey: set(env.STRIPE_API_KEY),
      webhookSecret: set(env.STRIPE_SIGNING_SECRET),
      basePrice: set(env.STRIPE_PRICE_ID),
      packPrice: set(env.STRIPE_SEAT_PRICE_ID),
    },
    fleet: {
      multiNodeScheduling: env.FEATURE_MULTI_NODE_SCHEDULING === "true",
      providerHetzner: set(env.HETZNER_API_TOKEN),
      dnsCloudflare: set(env.CLOUDFLARE_DNS_API_TOKEN) && set(env.CLOUDFLARE_DNS_ZONE_ID),
      nodeDomain: set(env.FLEET_NODE_DOMAIN) ? env.FLEET_NODE_DOMAIN : null,
      singboxVpnVersion: set(env.FLEET_SINGBOX_VPN_VERSION) ? env.FLEET_SINGBOX_VPN_VERSION : null,
      realityHandshakeServer: set(env.FLEET_REALITY_HANDSHAKE_SERVER) ? env.FLEET_REALITY_HANDSHAKE_SERVER : null,
      tickSecret: set(env.FLEET_TICK_SECRET),
    },
    services: {
      credentialEncryption: set(env.VPN_SECRETS_ENCRYPTION_KEY),
      email: set(env.RESEND_API_KEY),
      telegram: set(env.TELEGRAM_BOT_TOKEN),
      siteUrl: set(env.SITE_URL) ? env.SITE_URL : null,
    },
    // Presence-only readiness list, grouped (never includes values).
    readiness: configPresence(env),
  });
}
