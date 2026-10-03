import { replaceAccessLink, UUID } from "../../../../../lib/links-service.js";
import { withV1User, v1Error, v1Json } from "../../../../../lib/v1-http.js";

export const onRequestPost = (context) => withV1User(context, "v1/links/:id/clients/:clientId/replace-link POST", async (db, user) => {
  if (!UUID.test(context.params.id) || !UUID.test(context.params.clientId)) return v1Error(400, "Invalid Link or client id.", "invalid_id");
  const result = await replaceAccessLink(db, context.env, context.request, user, context.params.id, context.params.clientId);
  return v1Json(result.body, result.status);
});
