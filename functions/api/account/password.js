import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../lib/user-auth.js";

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 128) {
    return jsonResponse({ error: "Password must be between 12 and 128 characters." }, 400);
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
    if (error) {
      console.error("account/password: Supabase update failed:", error.message);
      return jsonResponse({ error: "Could not update password." }, 400);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("account/password: failed:", err.message);
    return jsonResponse({ error: "Could not update password." }, 500);
  }
}
