import { createLink, listLinks, parseCreateLink } from "../../lib/links-service.js";
import { readV1Json, withV1User, v1Error, v1Json } from "../../lib/v1-http.js";

const respond = (result) => result.status === 204 ? new Response(null, { status: 204 }) : v1Json(result.body, result.status);

export const onRequestGet = (context) => withV1User(context, "v1/links GET", async (db, user) =>
  respond(await listLinks(db, user)));

export const onRequestPost = (context) => withV1User(context, "v1/links POST", async (db, user) => {
  const parsed = await readV1Json(context.request);
  if (parsed.error) return parsed.error;
  const input = parseCreateLink(parsed.body);
  if (!input) return v1Error(400, "Invalid Link request.", "invalid_request");
  return respond(await createLink(db, user, input));
});
