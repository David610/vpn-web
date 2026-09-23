import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const { data, error } = await supabaseAdmin.rpc("admin_overview_snapshot");
    if (error) throw new Error(`admin_overview_snapshot failed: ${error.message}`);
    if (!data) throw new Error("admin_overview_snapshot returned no data");

    return jsonResponse(data);
  } catch (err) {
    console.error("admin/overview: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
