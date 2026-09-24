import { renameSubscription } from "../../../lib/account-service.js";
import { fromService, readV1Json, withV1User } from "../../../lib/v1-http.js";

/** PATCH /v1/subscriptions/{id} — { name }. */
export async function onRequestPatch(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;
  return withV1User(context, "v1/subscriptions/:id", async (db, user) =>
    fromService(await renameSubscription(db, user, context.params.id, body.name))
  );
}
