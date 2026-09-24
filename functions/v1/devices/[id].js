import { moveDevice, removeDevice, renameDevice } from "../../lib/account-service.js";
import { fromService, readV1Json, withV1User } from "../../lib/v1-http.js";

/** PATCH /v1/devices/{id} — { name } or { subscription_id }. */
export async function onRequestPatch(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;
  return withV1User(context, "v1/devices/:id", async (db, user) => {
    if (body.subscription_id !== undefined) {
      return fromService(await moveDevice(db, context.env, user, context.params.id, body.subscription_id));
    }
    return fromService(await renameDevice(db, user, context.params.id, body.name));
  });
}

/** DELETE /v1/devices/{id} — revokes the device's access and frees its place. */
export const onRequestDelete = (context) =>
  withV1User(context, "v1/devices/:id", async (db, user) =>
    fromService(await removeDevice(db, context.env, user, context.params.id))
  );
