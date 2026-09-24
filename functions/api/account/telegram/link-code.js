import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../../lib/user-auth.js";
import { generateLinkCode, hashLinkCode, LINK_CODE_TTL_SECONDS } from "../../../lib/telegram-link-code.js";

/**
 * Issues a short-lived linking code the customer sends to the bot / enters
 * in the Mini App, proving they control both the Arcana session and the
 * Telegram account. requireRecentUser() because this is the first step of
 * granting a new identity access to the account, same recency bar as
 * password changes and invite creation.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const { data: existingLink, error: linkError } = await supabaseAdmin
      .from("telegram_links")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (linkError) throw new Error(`telegram_links lookup failed: ${linkError.message}`);
    if (existingLink) {
      return jsonResponse({ error: "A Telegram account is already linked." }, 409);
    }

    const code = generateLinkCode();
    const codeHash = await hashLinkCode(code);
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_SECONDS * 1000).toISOString();

    const { error: insertError } = await supabaseAdmin
      .from("telegram_link_codes")
      .insert({ code_hash: codeHash, user_id: user.id, expires_at: expiresAt });
    if (insertError) throw new Error(`telegram_link_codes insert failed: ${insertError.message}`);

    return jsonResponse({ code, expiresAt });
  } catch (err) {
    console.error("account/telegram/link-code: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
