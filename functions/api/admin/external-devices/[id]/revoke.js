import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";

export async function onRequestPost({ env, request, params }) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { admin, response } = await requireAdmin(request, db);
  if (!admin) return response;
  const { data: device, error: lookupError } = await db.from("external_vpn_devices")
    .select("device_id,account_id,principal_id").eq("device_id", params.id).maybeSingle();
  if (lookupError) return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  if (!device) return new Response(JSON.stringify({ error: "External device not found" }), { status: 404, headers });
  const { data, error } = await db.rpc("revoke_external_vpn_device", { p_device_id: device.device_id, p_account_id: device.account_id });
  if (error) return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers });
  return new Response(JSON.stringify({ revoked: data === true }), { status: 200, headers });
}
