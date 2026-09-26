import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../../../lib/user-auth.js";
import { assignDeviceProfile } from "../../../../lib/device-assignment.js";

/**
 * Reassigns a device's connection profile. The rules live in
 * functions/lib/device-assignment.js, shared with the Telegram Mini App.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  try {
    const { status, body: result } = await assignDeviceProfile(supabaseAdmin, env, user, params.id, body?.profileId);
    return jsonResponse(result, status);
  } catch (err) {
    console.error("account/devices/:id/assignment: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
