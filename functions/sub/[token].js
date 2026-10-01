import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto.js";
import { rateLimitKeyHash, subscriptionTokenHash } from "../lib/external-credentials.js";
import { renderers, UnsupportedClientModeError } from "../lib/subscription-renderers.js";
import { checkRateLimit, clientIpKey, rateLimitedResponse } from "../lib/rate-limit.js";

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
  const ipHash = await rateLimitKeyHash(clientIpKey(request), env);
  if (!(await checkRateLimit(db, `sub:token:${tokenHash}`, { windowSeconds: 60, limit: 30 })) ||
      !(await checkRateLimit(db, `sub:ip:${ipHash}`, { windowSeconds: 60, limit: 120 }))) return rateLimitedResponse();

  const { data: device, error } = await db.from("external_vpn_devices")
    .select("device_id,client_type,principal_id,desired_route_id,revoked_at,subscription_expires_at")
    .eq("subscription_token_hash", tokenHash).maybeSingle();
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
    .select("hop,node_id,priority").eq("route_id", route.id).eq("enabled", true).eq("published", true)
    .order("hop").order("priority");
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
  const exitTarget = selected.find((t) => t.hop === (route.privacy_class === "privacy_plus" ? 2 : 1));
  if (!exitTarget) return reply({ error: "Route temporarily unavailable" }, 503);

  const { data: credentials, error: credentialError } = await db.from("compatibility_credentials")
    .select("credential_id,credential_ciphertext,credential_nonce,valid_from,valid_until,publish_from,revoked_at")
    .eq("device_id", device.device_id).is("revoked_at", null).order("publish_from", { ascending: false });
  if (credentialError) return reply({ error: "Credential temporarily unavailable" }, 503);
  const nowMs = Date.now();
  const candidates = (credentials ?? []).filter((c) =>
    Date.parse(c.publish_from) <= nowMs && Date.parse(c.valid_until) > nowMs);
  const candidateIds = candidates.map((c) => c.credential_id);
  const { data: loadedAuthorizations, error: loadedError } = candidateIds.length
    ? await db.from("compatibility_authorizations")
      .select("credential_id,loaded_at,revoked,valid_from,valid_until")
      .eq("node_id", exitTarget.node_id)
      .in("credential_id", candidateIds)
    : { data: [], error: null };
  if (loadedError) return reply({ error: "Credential temporarily unavailable" }, 503);
  const loadedIds = new Set((loadedAuthorizations ?? [])
    .filter((a) => a.loaded_at && !a.revoked && Date.parse(a.valid_from) <= nowMs && Date.parse(a.valid_until) > nowMs)
    .map((a) => a.credential_id));
  // Prefer the newest published generation only after the selected live node
  // has explicitly acknowledged that generation. Until then A remains valid.
  const credential = candidates.find((c) => loadedIds.has(c.credential_id));
  if (!credential) return reply({ error: "Credential temporarily unavailable" }, 503);
  let material;
  try { material = JSON.parse(await decryptSecret(credential.credential_ciphertext, credential.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY)); }
  catch { return reply({ error: "Credential temporarily unavailable" }, 503); }

  const routeMaterial = (n) => ({ server: n.hostname || n.ip_address, port: n.transport_port,
    tlsServerName: n.tls_server_name, realityPublicKey: n.reality_public_key,
    realityShortId: n.reality_short_id, realityFingerprint: n.reality_fingerprint, vlessFlow: n.vless_flow });
  const publicRoute = { ...routeMaterial(exitTarget.node), displayName: route.display_name,
    mode: route.privacy_class, entry: route.privacy_class === "privacy_plus" ? routeMaterial(selected.find((t) => t.hop === 1)?.node) : null };
  try {
    const rendered = renderers[format]({ route: publicRoute, credential: material });
    await db.from("external_vpn_devices").update({ last_subscription_fetch_at: new Date().toISOString() })
      .eq("device_id", device.device_id).eq("subscription_token_hash", tokenHash);
    return reply(rendered, 200, format === "singbox" || format === "xray" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  } catch (err) {
    if (err instanceof UnsupportedClientModeError) return reply({ error: err.message, code: "unsupported_client_mode" }, 422);
    return reply({ error: "Rendering failed" }, 500);
  }
}