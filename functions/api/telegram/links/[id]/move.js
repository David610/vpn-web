import { readJson } from "../../../../lib/account-http.js";
import { checkRateLimit } from "../../../../lib/rate-limit.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";
import { moveMiniAppLink } from "../../../../lib/telegram-mini-app-service.js";

/** Body: { locationMode: "auto"|"manual", routeId? }. Replaces the link with one on the new route. */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/links/:id/move",
    async (db, user) => {
      const allowed = await checkRateLimit(db, `tg-links-write:${user.id}`, {
        windowSeconds: 60,
        limit: 10,
        env: context.env,
      });
      if (!allowed) return { status: 429, body: { error: "Too many requests. Please try again shortly." } };
      return moveMiniAppLink(db, context.env, context.request, user, context.params.id, body);
    },
    { write: true }
  );
}
