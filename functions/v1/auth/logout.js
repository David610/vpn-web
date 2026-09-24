import { signOutSession } from "../../lib/gotrue.js";
import { releaseSessionDevice } from "../../lib/account-service.js";
import { noContent, withV1User } from "../../lib/v1-http.js";

/**
 * POST /v1/auth/logout — ends this device's session and frees its place in
 * the subscription. The account and its subscriptions stay.
 */
export const onRequestPost = (context) =>
  withV1User(context, "v1/auth/logout", async (db, user, sessionId) => {
    await releaseSessionDevice(db, context.env, user, sessionId);
    const token = context.request.headers.get("Authorization").slice(7);
    await signOutSession(context.env, token);
    return noContent();
  });
