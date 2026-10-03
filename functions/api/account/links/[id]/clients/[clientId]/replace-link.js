import { runAccountAction } from "../../../../../../lib/account-http.js";
import { replaceAccessLink } from "../../../../../../lib/links-service.js";

export async function onRequestPost(context) {
  return runAccountAction(context, "link client access-link replacement", async (db, user) => {
    const result = await replaceAccessLink(db, context.env, context.request, user, context.params.id, context.params.clientId);
    if (result.status >= 400) return result;
    return { status: 200, body: { client: result.body.client, subscriptionUrl: result.body.configuration_url, shownOnce: true } };
  });
}
