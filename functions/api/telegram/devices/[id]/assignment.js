import { readJson } from "../../../../lib/account-http.js";
import { assignDeviceProfile } from "../../../../lib/device-assignment.js";
import { runMiniAppAction } from "../../../../lib/telegram-mini-app-http.js";

/** Body: { profileId } */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(
    context,
    "telegram/devices/:id/assignment",
    (db, user) => assignDeviceProfile(db, context.env, user, context.params.id, body?.profileId),
    { write: true }
  );
}
