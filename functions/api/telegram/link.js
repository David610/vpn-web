import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "../../lib/user-auth.js";
import { verifyTelegramInitData } from "../../lib/telegram-init-data.js";
import { hashLinkCode } from "../../lib/telegram-link-code.js";

/**
 * Called by the Mini App (never by a normal browser session -- there is no
 * Authorization: Bearer header here, only X-Telegram-Init-Data) to consume
 * a linking code issued by POST /api/account/telegram/link-code and bind
 * the Telegram account the initData was signed for to that code's
 * account.
 *
 * Two independently-verified facts are required before a link is created:
 * the initData signature (proves this request really comes from this
 * Telegram user, via the bot token secret) and the code hash match (proves
 * this Telegram user was handed the code by the account owner). Neither
 * alone is sufficient.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const initData = request.headers.get("X-Telegram-Init-Data");
  if (!initData) return jsonResponse({ error: "Missing Telegram initData" }, 401);

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return jsonResponse({ error: "Invalid Telegram initData" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return jsonResponse({ error: "Missing code" }, 400);

  try {
    const codeHash = await hashLinkCode(code);
    const { data: linkCode, error: codeError } = await supabaseAdmin
      .from("telegram_link_codes")
      .select("code_hash, user_id, expires_at, consumed_at")
      .eq("code_hash", codeHash)
      .maybeSingle();
    if (codeError) throw new Error(`telegram_link_codes lookup failed: ${codeError.message}`);

    if (!linkCode || linkCode.consumed_at || new Date(linkCode.expires_at).getTime() <= Date.now()) {
      return jsonResponse({ error: "Invalid or expired code" }, 400);
    }

    const { data: existingLink, error: existingError } = await supabaseAdmin
      .from("telegram_links")
      .select("user_id")
      .eq("telegram_user_id", verified.user.id)
      .maybeSingle();
    if (existingError) throw new Error(`telegram_links lookup failed: ${existingError.message}`);
    if (existingLink) {
      return jsonResponse({ error: "This Telegram account is already linked to an account." }, 409);
    }

    // Mark the code consumed first, guarded on it still being unconsumed —
    // the same optimistic-concurrency shape as devices/[id]/revoke.js —
    // so a code cannot be replayed by two racing requests into two links.
    const { data: consumed, error: consumeError } = await supabaseAdmin
      .from("telegram_link_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("code_hash", codeHash)
      .is("consumed_at", null)
      .select("code_hash")
      .maybeSingle();
    if (consumeError) throw new Error(`telegram_link_codes update failed: ${consumeError.message}`);
    if (!consumed) {
      return jsonResponse({ error: "Invalid or expired code" }, 400);
    }

    const { error: insertError } = await supabaseAdmin.from("telegram_links").insert({
      user_id: linkCode.user_id,
      telegram_user_id: verified.user.id,
      telegram_username: verified.user.username,
    });
    if (insertError) {
      // The existingLink check above and this insert are not one
      // transaction, so two different races can land here:
      //   - two codes for the same Telegram account both pass the
      //     existingLink check and both consume, then collide on the
      //     telegram_user_id unique index;
      //   - two codes for the same *Arcana* user (issued by two
      //     concurrent link-code requests) both consume, then collide on
      //     telegram_links' user_id primary key instead.
      // Either way it is a real conflict, not an internal error, and
      // which side already holds a link is not safe to assert from the
      // error alone -- report it generically rather than guessing.
      if (insertError.code === "23505") {
        return jsonResponse({ error: "This account is already linked to a Telegram account." }, 409);
      }
      throw new Error(`telegram_links insert failed: ${insertError.message}`);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("telegram/link: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
