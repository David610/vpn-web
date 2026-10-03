import { getLink, revokeLink, UUID } from "../../../lib/links-service.js";
import { withV1User, v1Error, v1Json } from "../../../lib/v1-http.js";

export const onRequestGet = (context) => withV1User(context, "v1/links/:id GET", async (db, user) => {
  if (!UUID.test(context.params.id)) return v1Error(400, "Invalid Link id.", "invalid_id");
  const result = await getLink(db, user, context.params.id);
  return v1Json(result.body, result.status);
});

export const onRequestDelete = (context) => withV1User(context, "v1/links/:id DELETE", async (db, user) => {
  if (!UUID.test(context.params.id)) return v1Error(400, "Invalid Link id.", "invalid_id");
  const result = await revokeLink(db, user, context.params.id);
  return result.status === 204 ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }) : v1Json(result.body, result.status);
});
