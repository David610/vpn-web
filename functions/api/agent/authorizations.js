import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { decryptSecret } from "../../lib/crypto.js";

export async function onRequestGet({ env, request }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  const { data, error } = await db.from("compatibility_authorizations")
    .select("principal_id,credential_id,credential_class,logical_route_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce")
    .eq("node_id", nodeId);
  if (error) return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  try {
    const principals = [...new Set((data ?? []).map((row) => row.principal_id))];
    const { data: devices, error: deviceError } = principals.length
      ? await db.from("external_vpn_devices").select("device_id,principal_id,revoked_at").in("principal_id", principals)
      : { data: [], error: null };
    if (deviceError) throw new Error("device lookup failed");
    const deviceByPrincipal = new Map((devices ?? []).map((device) => [device.principal_id, device]));
    const entitlementByPrincipal = new Map();
    for (const principal of principals) {
      const device = deviceByPrincipal.get(principal);
      if (!device || device.revoked_at) { entitlementByPrincipal.set(principal, false); continue; }
      const { data: entitlement, error: entitlementError } = await db.rpc("device_entitlement", { p_device_id: device.device_id });
      if (entitlementError) throw new Error("entitlement lookup failed");
      const row = Array.isArray(entitlement) ? entitlement[0] : entitlement;
      entitlementByPrincipal.set(principal, row?.entitled === true);
    }
    const authorizations = await Promise.all((data ?? []).map(async (row) => ({
      principal_id: row.principal_id, credential_id: row.credential_id,
      class: row.credential_class, logical_route_id: row.logical_route_id,
      valid_from: row.valid_from, valid_until: row.valid_until,
      revoked: row.revoked || entitlementByPrincipal.get(row.principal_id) !== true,
      protocol: JSON.parse(await decryptSecret(row.credential_ciphertext, row.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY)),
    })));
    return new Response(JSON.stringify({ authorizations }), { status: 200, headers });
  } catch {
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  }
}

export async function onRequestPost({ env, request }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers }); }
  const credentialIds = body?.credential_ids;
  if (!Array.isArray(credentialIds) || credentialIds.length > 500 || credentialIds.some((id) => !/^cred_[A-Za-z0-9_-]{32,80}$/.test(id))) {
    return new Response(JSON.stringify({ error: "Invalid acknowledgement" }), { status: 400, headers });
  }
  const { data, error } = await db.rpc("ack_compatibility_authorizations", { p_node_id: nodeId, p_credential_ids: credentialIds });
  if (error) return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  return new Response(JSON.stringify({ acknowledged: data }), { status: 200, headers });
}
