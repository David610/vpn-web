import { readJson, runAccountAction } from "../../lib/account-http.js";
import { requestAccountDeletion } from "../../lib/account-service.js";

/** Body: { password }. Permanent; see requestAccountDeletion. */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runAccountAction(
    context,
    "account/delete",
    (db, user) => requestAccountDeletion(db, context.env, user, body?.password),
    { recent: false }
  );
}
