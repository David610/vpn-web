import { revealPrimaryAccessLink } from "../../../../lib/links-service.js";
import { checkRateLimit } from "../../../../lib/rate-limit.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

const REVEAL_WINDOW_SECONDS = 60;
const REVEAL_LIMIT_PER_USER = 30;

/**
 * The access URL is a bearer credential, so showing it needs initData signed
 * within the last hour (write: true) and is rate limited per user. Responses
 * are never cached.
 */
export const onRequestGet = (context) =>
  runMiniAppAction(
    context,
    "telegram/links/:id/access-link",
    async (db, user) => {
      const allowed = await checkRateLimit(db, `tg-link-access:${user.id}`, {
        windowSeconds: REVEAL_WINDOW_SECONDS,
        limit: REVEAL_LIMIT_PER_USER,
        env: context.env,
      });
      if (!allowed) return { status: 429, body: { error: "Too many requests. Please try again shortly." } };
      const result = await revealPrimaryAccessLink(db, context.env, context.request, user, context.params.id);
      return result.status === 200 ? { status: 200, body: { configurationUrl: result.body.configuration_url } } : result;
    },
    { write: true }
  );
