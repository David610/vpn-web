import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../../lib/user-auth.js";

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const { data: deleted, error } = await supabaseAdmin
      .from("telegram_links")
      .delete()
      .eq("user_id", user.id)
      .select("user_id")
      .maybeSingle();
    if (error) throw new Error(`telegram_links delete failed: ${error.message}`);
    if (!deleted) {
      return jsonResponse({ error: "No Telegram account is linked." }, 404);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("account/telegram/unlink: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
