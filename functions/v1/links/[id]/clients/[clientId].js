import { revokeClient, UUID } from "../../../../lib/links-service.js";
import { withV1User, v1Error, v1Json } from "../../../../lib/v1-http.js";

export const onRequestDelete = (context) => withV1User(context, "v1/links/:id/clients/:clientId DELETE", async (db, user) => {
  if (!UUID.test(context.params.id) || !UUID.test(context.params.clientId)) return v1Error(400, "Invalid Link or client id.", "invalid_id");
  const result = await revokeClient(db, user, context.params.id, context.params.clientId);
  return result.status === 204 ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }) : v1Json(result.body, result.status);
});
