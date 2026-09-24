import { setExtraPacks } from "../../../lib/account-service.js";
import { fromService, readV1Json, withV1User } from "../../../lib/v1-http.js";

/** PUT /v1/subscriptions/{id}/packs — { extra_packs }: absolute count. */
export async function onRequestPut(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;
  return withV1User(context, "v1/subscriptions/:id/packs", async (db, user) =>
    fromService(await setExtraPacks(db, context.env, user, context.params.id, body.extra_packs))
  );
}
