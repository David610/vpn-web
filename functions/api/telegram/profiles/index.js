import { readJson } from "../../../lib/account-http.js";
import { createProfile } from "../../../lib/connection-profiles.js";
import { runMiniAppAction } from "../../../lib/telegram-mini-app-http.js";
import { getMiniAppProfiles } from "../../../lib/telegram-mini-app-service.js";

export const onRequestGet = (context) => runMiniAppAction(context, "telegram/profiles", getMiniAppProfiles);

/** Body: { name, routingMode: AUTO|DIRECT|DOUBLE_HOP, entryLocationId?, exitLocationId? } */
export async function onRequestPost(context) {
  const { body, error } = await readJson(context.request);
  if (error) return error;
  return runMiniAppAction(context, "telegram/profiles POST", (db, user) => createProfile(db, context.env, user, body), {
    write: true,
  });
}
