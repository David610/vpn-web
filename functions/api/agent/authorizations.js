import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { decryptSecret } from "../../lib/crypto.js";

export async function onRequestGet({ env, request }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  const now = new Date().toISOString();
  const { data, error } = await db.from("compatibility_authorizations")
    .select("principal_id,credential_id,credential_class,logical_route_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce")
    .eq("node_id", nodeId)
    .eq("revoked", false)
    .gt("valid_until", now);
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