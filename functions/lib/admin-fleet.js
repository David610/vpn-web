/**
 * Shared helpers for the read-only admin Fleet views
 * (functions/api/admin/fleet/**) and the admin Settings readiness list.
 *
 * Two jobs:
 *   1. stripFleetSecrets(): a defence-in-depth scrub applied to every admin
 *      fleet response body. Queries already select explicit, non-secret
 *      columns; this guarantees that a future `select("*")`, a jsonb detail
 *      blob or a revision config can never leak a credential.
 *   2. CONFIG_VARIABLES: the runtime-variable inventory shown (presence
 *      only, never values) on admin Settings. Keep in sync with
 *      docs/PRODUCTION_CONFIG.md and .dev.vars.example.
 */

// Exact keys that are always credentials, in either snake_case (DB rows,
// jsonb) or camelCase (response objects).
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "api_key_hash",
  "apiKeyHash",
  "enrollment_token",
  "enrollmentToken",
  "enrollment_token_hash",
  "enrollmentTokenHash",
  "subscription_url",
  "subscriptionUrl",
  "subscription_token",
  "subscriptionToken",
  "vless_uuid",
  "vlessUuid",
  "uuid",
  "hysteria2_password",
  "hysteria2Password",
  "password",
  "private_key",
  "privateKey",
  "reality_private_key",
  "realityPrivateKey",
  "service_role_key",
  "serviceRoleKey",
  "secret",
  "token",
]);

// Substring patterns for anything that looks like a secret even if its
// exact name is new. Public REALITY keys and short ids are fine to show.
const SECRET_PATTERNS = [
  /private[_-]?key/i,
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /service[_-]?role/i,
  /token/i,
  /credential/i,
  /^sk_/i,
  /^whsec/i,
];

export function isSecretKey(key) {
  if (SECRET_KEYS.has(key)) return true;
  return SECRET_PATTERNS.some((re) => re.test(key));
}

/** Recursively drops secret-looking keys from plain objects/arrays. */
export function stripFleetSecrets(value) {
  if (Array.isArray(value)) return value.map(stripFleetSecrets);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (isSecretKey(key)) continue;
      out[key] = stripFleetSecrets(inner);
    }
    return out;
  }
  return value;
}

export function fleetJson(body, status = 200) {
  return new Response(JSON.stringify(stripFleetSecrets(body)), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Runtime variables of the Cloudflare Pages Functions, grouped for the
 * admin Settings readiness view. `secret: true` means "set as an encrypted
 * Pages secret"; the API only ever reports presence.
 */
export const CONFIG_VARIABLES = [
  // Core
  { name: "SUPABASE_URL", group: "Core", secret: false, required: true, purpose: "Supabase project URL for all server calls" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", group: "Core", secret: true, required: true, purpose: "Server-side Supabase access" },
  { name: "SUPABASE_ANON_KEY", group: "Core", secret: false, required: false, purpose: "GoTrue calls (falls back to service role)" },
  { name: "SITE_URL", group: "Core", secret: false, required: true, purpose: "Absolute links in email/Stripe redirects" },
  { name: "VPN_SECRETS_ENCRYPTION_KEY", group: "Core", secret: true, required: true, purpose: "Encrypts VPN credentials at rest" },
  // Billing
  { name: "STRIPE_API_KEY", group: "Billing", secret: true, required: true, purpose: "Stripe checkout/portal/subscription API" },
  { name: "STRIPE_SIGNING_SECRET", group: "Billing", secret: true, required: true, purpose: "Stripe webhook signature check" },
  { name: "STRIPE_PRICE_ID", group: "Billing", secret: false, required: true, purpose: "Base subscription price (3 devices)" },
  { name: "STRIPE_SEAT_PRICE_ID", group: "Billing", secret: false, required: true, purpose: "+3-device pack price (legacy name)" },
  // Messaging
  { name: "RESEND_API_KEY", group: "Messaging", secret: true, required: true, purpose: "Transactional + alert email" },
  { name: "ALERT_FROM_EMAIL", group: "Messaging", secret: false, required: false, purpose: "From address (default onboarding@resend.dev)" },
  { name: "TELEGRAM_BOT_TOKEN", group: "Messaging", secret: true, required: false, purpose: "Telegram linking + Mini App initData HMAC" },
  // Fleet provisioning
  { name: "HETZNER_API_TOKEN", group: "Fleet provisioning", secret: true, required: true, purpose: "Create/delete node VMs" },
  { name: "FLEET_HETZNER_SERVER_TYPE", group: "Fleet provisioning", secret: false, required: false, purpose: "VM type override" },
  { name: "FLEET_HETZNER_IMAGE", group: "Fleet provisioning", secret: false, required: false, purpose: "VM image override" },
  { name: "FLEET_DNS_PROVIDER", group: "Fleet provisioning", secret: false, required: false, purpose: "DNS adapter (default cloudflare)" },
  { name: "CLOUDFLARE_DNS_API_TOKEN", group: "Fleet provisioning", secret: true, required: true, purpose: "Publish node A records" },
  { name: "CLOUDFLARE_DNS_ZONE_ID", group: "Fleet provisioning", secret: false, required: true, purpose: "Zone holding FLEET_NODE_DOMAIN" },
  { name: "FLEET_NODE_DOMAIN", group: "Fleet provisioning", secret: false, required: true, purpose: "Node hostnames <id>.<domain>" },
  { name: "FLEET_SINGBOX_VPN_VERSION", group: "Fleet provisioning", secret: false, required: true, purpose: "Pinned singbox-vpn release" },
  { name: "FLEET_SINGBOX_VPN_REPO", group: "Fleet provisioning", secret: false, required: false, purpose: "Release repo override" },
  { name: "FLEET_REALITY_HANDSHAKE_SERVER", group: "Fleet provisioning", secret: false, required: true, purpose: "REALITY camouflage handshake target" },
  { name: "FLEET_TICK_SECRET", group: "Fleet provisioning", secret: true, required: true, purpose: "Authenticates pg_cron fleet-tick" },
  // Routes
  { name: "ROUTE_SIGNING_PRIVATE_KEY", group: "Route signing", secret: true, required: true, purpose: "Signs /v1/routes directory" },
  { name: "ROUTE_SIGNING_KEY_ID", group: "Route signing", secret: false, required: true, purpose: "Key id clients pin" },
  // Automation flags
  { name: "FEATURE_MULTI_NODE_SCHEDULING", group: "Fleet automation flags", secret: false, required: false, flag: true, purpose: "Scheduler places devices across nodes" },
  { name: "FEATURE_AUTO_NODE_HEALTH", group: "Fleet automation flags", secret: false, required: false, flag: true, purpose: "Probe/silence-driven lifecycle changes" },
  { name: "FEATURE_AUTO_NODE_REPLACE", group: "Fleet automation flags", secret: false, required: false, flag: true, purpose: "Auto-replace long-FAILED nodes" },
  { name: "FEATURE_AUTO_NODE_REPLACE_CANARY", group: "Fleet automation flags", secret: false, required: false, flag: true, purpose: "Auto-replacements go through CANARY" },
  { name: "FEATURE_AUTO_NODE_SCALE", group: "Fleet automation flags", secret: false, required: false, flag: true, purpose: "Add nodes to full locations" },
  { name: "AUTO_REPLACE_AFTER_FAILED_MS", group: "Fleet automation flags", secret: false, required: false, purpose: "FAILED age before auto-replace" },
  { name: "FLEET_AUTO_REPLACE_REGION", group: "Fleet automation flags", secret: false, required: false, purpose: "Provider region for auto-replace" },
  { name: "FLEET_AUTO_SCALE_REGION", group: "Fleet automation flags", secret: false, required: false, purpose: "Provider region for auto-scale" },
];

const present = (v) => typeof v === "string" && v.length > 0;

/** Presence-only view of CONFIG_VARIABLES. Never includes a value. */
export function configPresence(env) {
  return CONFIG_VARIABLES.map((v) => {
    const row = { name: v.name, group: v.group, sensitive: v.secret, required: v.required, purpose: v.purpose, present: present(env?.[v.name]) };
    if (v.flag) row.enabled = env?.[v.name] === "true";
    return row;
  });
}

/** Service-role client + requireAdmin in one call for the fleet views. */
export async function fleetAdminContext(env, request, { createClient, requireAdmin }) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabase);
  return { supabase, admin, response };
}

export function mapOperation(op, steps = []) {
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    nodeId: op.node_id ?? null,
    attempts: op.attempts ?? 0,
    lastError: op.last_error ?? null,
    nextAttemptAt: op.next_attempt_at ?? null,
    deadlineAt: op.deadline_at ?? null,
    createdAt: op.created_at,
    updatedAt: op.updated_at,
    detail: op.detail ?? {},
    steps: steps
      .filter((s) => s.operation_id === op.id)
      .sort((a, b) => a.step_index - b.step_index)
      .map((s) => ({
        index: s.step_index,
        name: s.name ?? null,
        status: s.status,
        nodeId: s.node_id ?? null,
        attempts: s.attempts ?? 0,
        error: s.error ?? null,
        startedAt: s.started_at ?? null,
        completedAt: s.completed_at ?? null,
        detail: s.detail ?? {},
      })),
  };
}

export const OPERATION_COLUMNS =
  "id, type, status, node_id, attempts, last_error, next_attempt_at, deadline_at, created_at, updated_at, detail";
export const STEP_COLUMNS =
  "operation_id, step_index, name, status, node_id, attempts, error, started_at, completed_at, detail";
