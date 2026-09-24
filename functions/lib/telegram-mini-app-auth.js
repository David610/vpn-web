import { verifyTelegramInitData } from "./telegram-init-data.js";
import { jsonResponse } from "./user-auth.js";

/**
 * Resolves a Telegram Mini App request to the same "authenticated user"
 * shape requireUser() produces (functions/lib/user-auth.js), so existing
 * functions/api/account/** handlers can accept either a normal Supabase
 * bearer session or a validated Mini App caller without being duplicated
 * per-surface.
 *
 * The Mini App sends its `initData` string in the X-Telegram-Init-Data
 * header on every request (not a cookie/session -- Telegram's model is
 * "re-validate the signed payload each time", not "exchange it for a
 * session token").
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ TELEGRAM_BOT_TOKEN?: string }} env
 * @returns {Promise<{ user: {id:string,email:string|null,role:string}|null, response: Response|null }>}
 */
export async function requireMiniAppUser(request, supabaseAdmin, env) {
  const initData = request.headers.get("X-Telegram-Init-Data");
  if (!initData) {
    return { user: null, response: jsonResponse({ error: "Missing Telegram initData" }, 401) };
  }

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) {
    return { user: null, response: jsonResponse({ error: "Invalid Telegram initData" }, 401) };
  }

  const { data: link, error } = await supabaseAdmin
    .from("telegram_links")
    .select("user_id")
    .eq("telegram_user_id", verified.user.id)
    .maybeSingle();
  if (error) {
    console.error("requireMiniAppUser: telegram_links lookup failed:", error.message);
    return { user: null, response: jsonResponse({ error: "Internal error" }, 500) };
  }
  if (!link) {
    return {
      user: null,
      response: jsonResponse({ error: "Telegram account not linked", code: "not_linked" }, 403),
    };
  }

  return {
    user: { id: link.user_id, email: null, role: "authenticated" },
    response: null,
  };
}
