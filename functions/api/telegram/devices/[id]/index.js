import { readJson } from "../../../../lib/account-http.js";
import { removeDevice, renameDevice } from "../../../../lib/account-service.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

/** Body: { name } */
export async function onRequestPatch(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/devices/:id PATCH",
    (db, user) => renameDevice(db, user, context.params.id, body?.name),
    { write: true }
  );
}

export const onRequestDelete = (context) =>
  runMiniAppAction(
    context,
    "telegram/devices/:id DELETE",
    (db, user) => removeDevice(db, context.env, user, context.params.id),
    { write: true }
  );
