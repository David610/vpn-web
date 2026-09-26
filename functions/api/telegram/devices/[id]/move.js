import { readJson } from "../../../../lib/account-http.js";
import { moveDevice } from "../../../../lib/account-service.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

/** Body: { subscriptionId } */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/devices/:id/move",
    (db, user) => moveDevice(db, context.env, user, context.params.id, body?.subscriptionId),
    { write: true }
  );
}
