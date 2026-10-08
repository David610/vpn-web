import { replacePrimaryAccessLink } from "../../../../lib/links-service.js";
import { checkRateLimit } from "../../../../lib/rate-limit.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

/** Issues a new access link; the previous one stops working immediately. */
export const onRequestPost = (context) =>
  runMiniAppAction(
    context,
    "telegram/links/:id/replace",
    async (db, user) => {
      const allowed = await checkRateLimit(db, `tg-links-write:${user.id}`, {
        windowSeconds: 60,
        limit: 10,
        env: context.env,
      });
      if (!allowed) return { status: 429, body: { error: "Too many requests. Please try again shortly." } };
      const result = await replacePrimaryAccessLink(db, context.env, context.request, user, context.params.id);
      return result.status === 200 ? { status: 200, body: { configurationUrl: result.body.configuration_url } } : result;
    },
    { write: true }
  );
