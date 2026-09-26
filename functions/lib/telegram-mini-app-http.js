/**
 * HTTP wrapper for the Telegram Mini App endpoints (functions/api/telegram/*),
 * the Mini App counterpart of runAccountAction (account-http.js):
 * authenticates the X-Telegram-Init-Data header via requireMiniAppUser and
 * turns a shared service's { status, body } into a response.
 *
 * Reads accept initData up to 24h old (Telegram signs it once per Mini App
 * open). Anything that changes the account additionally requires initData
 * signed within the last hour, the Mini App's equivalent of the website's
 * "recent sign-in" rule; the client reopens the Mini App to get a fresh one.
 */
import { adminClient } from "./account-http.js";
import { jsonResponse } from "./user-auth.js";
import { requireMiniAppUser } from "./telegram-mini-app-auth.js";
import { verifyTelegramInitData } from "./telegram-init-data.js";

export const WRITE_MAX_AGE_SECONDS = 60 * 60;

/**
 * @param {{ env: object, request: Request }} context
 * @param {string} label - log prefix; never includes request data.
 * @param {(db: object, user: {id:string,email:null,role:string}) => Promise<{status:number, body:object}>} action
 * @param {{ write?: boolean }} [options]
 */
export async function runMiniAppAction(context, label, action, { write = false } = {}) {
  const { env, request } = context;
  const supabaseAdmin = adminClient(env);

  if (write) {
    const initData = request.headers.get("X-Telegram-Init-Data");
    if (initData) {
      const fresh = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, WRITE_MAX_AGE_SECONDS);
      if (!fresh.ok && fresh.reason === "stale auth_date") {
        const withinReadWindow = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (withinReadWindow.ok) {
          return jsonResponse(
            { error: "Close and reopen the app to confirm this change.", code: "reopen_required" },
            401
          );
        }
      }
    }
  }

  const { user, response } = await requireMiniAppUser(request, supabaseAdmin, env);
  if (!user) return response;
  try {
    const { status, body } = await action(supabaseAdmin, user);
    return jsonResponse(body, status);
  } catch (err) {
    console.error(`${label}: unexpected error:`, err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
