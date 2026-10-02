import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { decryptSecret } from "../../lib/crypto.js";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

async function renderAuthorizations(rows, db, env, { legacy }) {
  const principals = [...new Set(rows.map((row) => row.principal_id))];
  const { data: devices, error: deviceError } = principals.length
    ? await db.from("external_vpn_devices").select("device_id,principal_id,revoked_at").in("principal_id", principals)
    : { data: [], error: null };
  if (deviceError) throw new Error("device lookup failed");
  const deviceByPrincipal = new Map((devices ?? []).map((device) => [device.principal_id, device]));
  const entitlementByPrincipal = new Map();
  for (const principal of principals) {
    const device = deviceByPrincipal.get(principal);
    if (!device || device.revoked_at) { entitlementByPrincipal.set(principal, false); continue; }
    const { data: entitlement, error } = await db.rpc("device_entitlement", { p_device_id: device.device_id });
    if (error) throw new Error("entitlement lookup failed");
    const row = Array.isArray(entitlement) ? entitlement[0] : entitlement;
    entitlementByPrincipal.set(principal, row?.entitled === true);
  }
  return Promise.all(rows.map(async (row) => ({
    principal_id: row.principal_id,
    credential_id: row.credential_id,
    class: row.class ?? row.credential_class,
    ...(legacy ? { logical_route_id: row.logical_route_id } : {}),
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    revoked: row.revoked || entitlementByPrincipal.get(row.principal_id) !== true,
    protocol: JSON.parse(await decryptSecret(row.credential_ciphertext, row.credential_nonce, env.VPN_SECRETS_ENCRYPTION_KEY)),
  })));
}

export async function onRequestGet({ env, request }) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return response({ error: "Unauthorized" }, 401);
  const schema = new URL(request.url).searchParams.get("schema");
  if (schema !== null && schema !== "2") return response({ error: "Unsupported authorization schema" }, 400);
  try {
    if (schema === "2") {
      const { data, error } = await db.rpc("get_compatibility_authorization_snapshot", { p_node_id: nodeId });
      if (error) throw new Error("snapshot lookup failed");
      const snapshot = Array.isArray(data) ? data[0] : data;
      const authorizations = await renderAuthorizations(snapshot?.authorizations ?? [], db, env, { legacy: false });
      return response({ schema_version: 2, snapshot_revision: Number(snapshot?.snapshot_revision ?? 0), authorizations });
    }

    // Unversioned GET is frozen as the legacy vpn-web contract throughout the
    // transition. In particular it retains logical_route_id and has no schema
    // or snapshot fields.
    const { data, error } = await db.from("compatibility_authorizations")
      .select("principal_id,credential_id,credential_class,logical_route_id,valid_from,valid_until,revoked,credential_ciphertext,credential_nonce")
      .eq("node_id", nodeId);
    if (error) throw new Error("authorization lookup failed");
    return response({ authorizations: await renderAuthorizations(data ?? [], db, env, { legacy: true }) });
  } catch {
    return response({ error: "Internal error" }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return response({ error: "Unauthorized" }, 401);
  if (new URL(request.url).searchParams.get("schema") !== "2") return response({ error: "Schema 2 is required" }, 400);
  let body;
  try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, 400); }
  if (body?.schema_version !== 2 || !Number.isSafeInteger(body?.snapshot_revision) || body.snapshot_revision < 0) {
    return response({ error: "Invalid acknowledgement" }, 400);
  }
  const { data, error } = await db.rpc("ack_compatibility_authorization_snapshot", {
    p_node_id: nodeId, p_snapshot_revision: body.snapshot_revision,
  });
  if (error) {
    if (/future_snapshot_revision/.test(error.message ?? "")) return response({ error: "Snapshot revision is newer than desired" }, 409);
    return response({ error: "Internal error" }, 500);
  }
  const result = Array.isArray(data) ? data[0] : data;
  return response({ schema_version: 2, desired_revision: Number(result.desired_revision), applied_revision: Number(result.applied_revision), state: result.state });
}
