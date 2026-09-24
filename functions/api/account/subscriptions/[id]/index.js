import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { renameSubscription } from "../../../../lib/account-service.js";

export async function onRequestPatch(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runAccountAction(context, "account/subscriptions/:id", (db, user) =>
    renameSubscription(db, user, context.params.id, body?.name)
  );
}
