import { readJson } from "../../../lib/account-http.js";
import { deleteProfile, updateProfile } from "../../../lib/connection-profiles.js";
import { runMiniAppAction } from "../../../lib/telegram-mini-app-http.js";

export async function onRequestPatch(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/profiles/:id PATCH",
    (db, user) => updateProfile(db, context.env, user, context.params.id, body),
    { write: true }
  );
}

export const onRequestDelete = (context) =>
  runMiniAppAction(
    context,
    "telegram/profiles/:id DELETE",
    (db, user) => deleteProfile(db, context.env, user, context.params.id),
    { write: true }
  );
