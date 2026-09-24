import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../../lib/user-auth.js";

/**
 * Current Telegram link status for the caller's own account. Read-only,
 * so requireUser() rather than requireRecentUser() (consistent with GET
 * /api/account/devices).
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const { data: link, error } = await supabaseAdmin
      .from("telegram_links")
      .select("telegram_user_id, telegram_username, linked_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw new Error(`telegram_links lookup failed: ${error.message}`);

    return jsonResponse({
      linked: !!link,
      telegramUsername: link?.telegram_username ?? null,
      linkedAt: link?.linked_at ?? null,
    });
  } catch (err) {
    console.error("account/telegram: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
