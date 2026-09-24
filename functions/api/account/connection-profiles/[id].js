import { readJson, runAccountAction } from "../../../lib/account-http.js";
import { deleteProfile, updateProfile } from "../../../lib/connection-profiles.js";

export async function onRequestPatch(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runAccountAction(context, "account/connection-profiles/:id", (db, user) =>
    updateProfile(db, context.env, user, context.params.id, body)
  );
}

export const onRequestDelete = (context) =>
  runAccountAction(context, "account/connection-profiles/:id", (db, user) =>
    deleteProfile(db, context.env, user, context.params.id)
  );
