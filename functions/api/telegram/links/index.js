import { readJson } from "../../../lib/account-http.js";
import { checkRateLimit } from "../../../lib/rate-limit.js";
import { runMiniAppAction } from "../../../lib/telegram-mini-app-http.js";
import { createMiniAppLink, getMiniAppLinks } from "../../../lib/telegram-mini-app-service.js";

const WRITE_WINDOW_SECONDS = 60;
const WRITE_LIMIT_PER_USER = 10;

/** Every link on the account, the choosable locations, and the plan card. */
export const onRequestGet = (context) => runMiniAppAction(context, "telegram/links", getMiniAppLinks);

/** Body: { name, locationMode: "auto"|"manual", routeId? } */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/links POST",
    async (db, user) => {
      const allowed = await checkRateLimit(db, `tg-links-write:${user.id}`, {
        windowSeconds: WRITE_WINDOW_SECONDS,
        limit: WRITE_LIMIT_PER_USER,
        env: context.env,
      });
      if (!allowed) return { status: 429, body: { error: "Too many requests. Please try again shortly." } };
      return createMiniAppLink(db, context.env, context.request, user, body);
    },
    { write: true }
  );
}
