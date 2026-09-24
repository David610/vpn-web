import { readJson, runAccountAction } from "../../../../lib/account-http.js";
import { setExtraPacks } from "../../../../lib/account-service.js";

/** Body: { packs } — the absolute number of extra 3-device packs. */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runAccountAction(context, "account/subscriptions/:id/packs", (db, user) =>
    setExtraPacks(db, context.env, user, context.params.id, body?.packs)
  );
}
