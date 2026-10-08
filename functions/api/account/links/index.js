import { readJson, runAccountAction } from "../../../lib/account-http.js";
import { browserListLinks, createLink, parseCreateLink } from "../../../lib/links-service.js";

export async function onRequestGet(context) {
  return runAccountAction(context, "links GET", (db, user) => browserListLinks(db, user), { recent: false });
}

export async function onRequestPost(context) {
  return runAccountAction(context, "links POST", async (db, user) => {
    const parsed = await readJson(context.request);
    if (parsed.error) return { status: 400, body: { error: "Invalid JSON body" } };
    const input = parseCreateLink(parsed.body, "browser");
    if (!input) return { status: 400, body: { error: "Invalid Link request" } };
    const result = await createLink(db, user, input);
    return result.status === 201 ? { status: 201, body: { id: result.body.link.id } } : result;
  });
}
