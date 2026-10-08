import { browserGetLink, revokeLink } from "../../../../lib/links-service.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

export const onRequestGet = (context) =>
  runMiniAppAction(context, "telegram/links/:id", (db, user) => browserGetLink(db, user, context.params.id));

/** Revokes the link and every client under it. */
export const onRequestDelete = (context) =>
  runMiniAppAction(
    context,
    "telegram/links/:id DELETE",
    async (db, user) => {
      const result = await revokeLink(db, user, context.params.id);
      return result.status === 204 ? { status: 200, body: { revoked: true } } : result;
    },
    { write: true }
  );
