import { runAccountAction } from "../../../../../../lib/account-http.js";
import { checkRateLimit } from "../../../../../../lib/rate-limit.js";
import { revealAccessLink } from "../../../../../../lib/links-service.js";

const REVEAL_WINDOW_SECONDS = 60;
const REVEAL_LIMIT_PER_USER = 30;

/**
 * Returns the access URL of one of the caller's own link clients so it can be
 * copied again. Authenticated by the normal session (not "recent sign-in", so
 * copying keeps working for a long-lived session), rate limited per user,
 * never cached, and never logged: the URL is a bearer credential.
 */
export async function onRequestGet(context) {
  return runAccountAction(context, "link client access-link GET", async (db, user) => {
    const allowed = await checkRateLimit(db, `link-access-link:${user.id}`, {
      windowSeconds: REVEAL_WINDOW_SECONDS,
      limit: REVEAL_LIMIT_PER_USER,
      env: context.env,
    });
    if (!allowed) return { status: 429, body: { error: "Too many requests. Please try again shortly." } };
    const result = await revealAccessLink(db, context.env, context.request, user, context.params.id, context.params.clientId);
    if (result.status >= 400) return result;
    return { status: 200, body: { configurationUrl: result.body.configuration_url } };
  }, { recent: false });
}
