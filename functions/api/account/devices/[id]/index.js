import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { moveDevice, renameDevice } from "../../../../lib/account-service.js";

/** Body: { name } to rename, or { subscriptionId } to move. */
export async function onRequestPatch(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runAccountAction(context, "account/devices/:id", async (db, user) => {
    if (body?.subscriptionId !== undefined) {
      return moveDevice(db, context.env, user, context.params.id, body.subscriptionId);
    }
    return renameDevice(db, user, context.params.id, body?.name);
  });
}
