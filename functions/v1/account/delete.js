import { requestAccountDeletion } from "../../lib/account-service.js";
import { fromService, readV1Json, withV1User } from "../../lib/v1-http.js";

/** POST /v1/account/delete — { password }. Permanent. */
export async function onRequestPost(context) {
  const { body, error } = await readV1Json(context.request);
  if (error) return error;
  return withV1User(context, "v1/account/delete", async (db, user) =>
    fromService(await requestAccountDeletion(db, context.env, user, body.password))
  );
}
