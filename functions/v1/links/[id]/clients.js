import { createClient, parseCreateClient, UUID } from "../../../lib/links-service.js";
import { readV1Json, withV1User, v1Error, v1Json } from "../../../lib/v1-http.js";

export const onRequestPost = (context) => withV1User(context, "v1/links/:id/clients POST", async (db, user) => {
  if (!UUID.test(context.params.id)) return v1Error(400, "Invalid Link id.", "invalid_id");
  const parsed = await readV1Json(context.request);
  if (parsed.error) return parsed.error;
  const input = parseCreateClient(parsed.body);
  if (!input) return v1Error(400, "Invalid client request.", "invalid_request");
  const result = await createClient(db, context.env, context.request, user, context.params.id, input);
  return v1Json(result.body, result.status);
});
