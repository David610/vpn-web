import { renameSessionDevice } from "../../lib/account-service.js";
import { fromService, readV1Json, withV1User } from "../../lib/v1-http.js";

/** PATCH /v1/devices/current — { name }: names the device this app runs on. */
export async function onRequestPatch(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;
  return withV1User(context, "v1/devices/current", async (db, user, sessionId) =>
    fromService(await renameSessionDevice(db, context.env, user, sessionId, body.name))
  );
}
