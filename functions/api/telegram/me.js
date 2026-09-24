import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "../../lib/user-auth.js";
import { requireMiniAppUser } from "../../lib/telegram-mini-app-auth.js";
import { getAccountForUser } from "../../lib/accounts.js";

/**
 * Minimal Mini App smoke endpoint: given valid initData for an already
 * -linked Telegram account, resolves and returns the same account_id/role
 * shape GET /api/account already exposes to a normal browser session.
 * Demonstrates that existing functions/api/account/** business logic
 * (getAccountForUser, etc.) does not need to be duplicated for Telegram
 * callers -- only the auth adapter differs.
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireMiniAppUser(request, supabaseAdmin, env);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`telegram/me: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    return jsonResponse({ accountId: account.accountId, role: account.role });
  } catch (err) {
    console.error("telegram/me: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
