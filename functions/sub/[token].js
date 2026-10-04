import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto.js";
import { legacySubscriptionTokenHash, rateLimitIpHash, subscriptionTokenHash } from "../lib/external-credentials.js";
import { renderers, UnsupportedClientModeError } from "../lib/subscription-renderers.js";
import { checkRateLimit, clientIpKey, rateLimitedResponse } from "../lib/rate-limit.js";
import { selectCompatibilityPublication } from "../lib/compatibility-publication.js";

const SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
  Pragma: "no-cache", Expires: "0", "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  Vary: "Accept, User-Agent",
};
const reply = (body, status, type = "application/json; charset=utf-8") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, "Content-Type": type } });

export async function onRequestGet({ env, request, params }) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return reply({ error: "HTTPS required" }, 400);
  }
  const format = url.searchParams.get("format");
  if (!renderers[format]) return reply({ error: "Unsupported or missing format" }, 400);
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return reply({ error: "Subscription not found" }, 404);
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const tokenHash = await subscriptionTokenHash(token, env);
  const legacyTokenHash = await legacySubscriptionTokenHash(token, env);
  const ipHash = await rateLimitIpHash(clientIpKey(request), env);
  if (!(await checkRateLimit(db, `sub:token:${tokenHash}`, { windowSeconds: 60, limit: 30 })) ||
      !(await checkRateLimit(db, `sub:ip:${ipHash}`, { windowSeconds: 60, limit: 120 }))) return rateLimitedResponse();

  const { data: device, error } = await db.from("external_vpn_devices")
    .select("device_id,client_type,principal_id,desired_route_id,revoked_at,subscription_expires_at")
    .in("subscription_token_hash", [tokenHash, legacyTokenHash]).maybeSingle();
  if (error) return reply({ error: "Temporarily unavailable" }, 503);
  if (!device || device.revoked_at || (device.subscription_expires_at && Date.parse(device.subscription_expires_at) <= Date.now())) {
    return reply({ error: "Subscription not found" }, 404);
  }
  const { data: entitlement, error: entitlementError } = await db.rpc("device_entitlement", { p_device_id: device.device_id });
  if (entitlementError) return reply({ error: "Temporarily unavailable" }, 503);
  const entitlementRow = Array.isArray(entitlement) ? entitlement[0] : entitlement;
  if (!entitlementRow?.entitled) return reply({ error: "Subscription not found" }, 404);
  const { data: route } = await db.from("logical_routes").select("id,privacy_class,display_name,enabled")
    .eq("id", device.desired_route_id).maybeSingle();
  if (!route?.enabled) return reply({ error: "Route temporarily unavailable" }, 503);
  const { data: targets, error: targetError } = await db.from("logical_route_targets")
    .select("hop,node_id,priority").eq("route_id", route.id).eq("enabled", true).order("hop").order("priority");
  if (targetError || !targets?.length || (route.privacy_class === "privacy_plus" && !targets.some((t) => t.hop === 2))) {
    return reply({ error: "Route temporarily unavailable" }, 503);
  }
  const nodeIds = [...new Set(targets.map((t) => t.node_id))];
  const { data: nodes, error: nodesError } = await db.from("nodes")
    .select("node_id,hostname,ip_address,transport_port,tls_server_name,reality_public_key,reality_short_id,reality_fingerprint,vless_flow,lifecycle_state")
    .in("node_id", nodeIds).in("lifecycle_state", ["READY", "CANARY"]);
  if (nodesError) return reply({ error: "Route temporarily unavailable" }, 503);
  const byId = new Map((nodes ?? []).map((n) => [n.node_id, n]));
  const selected = targets.map((t) => ({ ...t, node: byId.get(t.node_id) })).filter((t) => t.node);
  if (!selected.find((t) => t.hop === (route.privacy_class === "privacy_plus" ? 2 : 1))) {
    return reply({ error: "Route temporarily unavailable" }, 503);
  }

  const { data: credentials, error: credentialError } = await db.from("compatibility_credentials")
    .select("hop,credential_id,credential_ciphertext,credential_nonce,valid_from,valid_until,publish_from,revoked_at")
    .eq("device_id", device.device_id).is("revoked_at", null).order("publish_from", { ascending: false });
  if (credentialError || !credentials?.length) return reply({ error: "Credential temporarily unavailable" }, 503);
  const now = Date.now();
  const eligibleCredentials = (credentials ?? []).filter((c) =>
    Date.parse(c.publish_from) <= now && Date.parse(c.valid_until) > now);
  if (!eligibleCredentials.length) return reply({ error: "Credential temporarily unavailable" }, 503);
  // Explicit two-stage rollout gate: deploy v2-capable agents first in
  // "legacy", observe ACKs, then deliberately switch to "enforce". Unknown
  // values fail closed rather than accidentally disabling the security gate.
  const ackMode = env.EXTERNAL_AUTHORIZATION_ACK_MODE ?? "legacy";
  if (!new Set(["legacy", "enforce"]).has(ackMode)) return reply({ error: "Route temporarily unavailable" }, 503);
  let proofs = [];
  if (ackMode === "enforce") {
    const { data, error: proofError } = await db.rpc("get_publishable_compatibility_deployments", {
      p_credential_ids: eligibleCredentials.map((c) => c.credential_id),
    });
    if (proofError) return reply({ error: "Route temporarily unavailable" }, 503);
    proofs = data ?? [];
  }
  const publication = selectCompatibilityPublication({ credentials: eligibleCredentials, targets: selected,
    proofs, mode: ackMode, privacyClass: route.privacy_class });
  if (!publication) return reply({ error: "Route temporarily unavailable" }, 503);
  const { exitCredential, entryCredential, exitTarget, entryTarget } = publication;
  let exitMaterial, entryMaterial;
  try {
    exitMaterial = JSON.parse(await decryptSecret(exitCredential.credential_ciphertext, exitCredential.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY));
    entryMaterial = entryCredential
      ? JSON.parse(await decryptSecret(entryCredential.credential_ciphertext, entryCredential.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY))
      : null;
  } catch { return reply({ error: "Credential temporarily unavailable" }, 503); }

  const routeMaterial = (n) => ({ server: n.hostname || n.ip_address, port: n.transport_port,
    tlsServerName: n.tls_server_name, realityPublicKey: n.reality_public_key,
    realityShortId: n.reality_short_id, realityFingerprint: n.reality_fingerprint, vlessFlow: n.vless_flow });
  const publicRoute = { ...routeMaterial(exitTarget.node), displayName: route.display_name,
    mode: route.privacy_class,
    entry: entryTarget ? { ...routeMaterial(entryTarget.node), vlessUuid: entryMaterial.vless_uuid } : null };
  try {
    const rendered = renderers[format]({ route: publicRoute, credential: exitMaterial });
    await db.from("external_vpn_devices").update({ last_subscription_fetch_at: new Date().toISOString() })
      .eq("device_id", device.device_id).in("subscription_token_hash", [tokenHash, legacyTokenHash]);
    return reply(rendered, 200, format === "singbox" || format === "xray" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  } catch (err) {
    if (err instanceof UnsupportedClientModeError) return reply({ error: err.message, code: "unsupported_client_mode" }, 422);
    return reply({ error: "Rendering failed" }, 500);
  }
}
