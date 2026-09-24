import { createClient } from "@supabase/supabase-js";
import { requireUser, requireRecentUser, jsonResponse } from "./user-auth.js";

export function adminClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function readJson(request) {
  try {
    const raw = await request.text();
    return { body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { error: jsonResponse({ error: "Invalid JSON body" }, 400) };
  }
}

/**
 * Runs an account action for the website: authenticates (recent sign-in
 * for anything that changes billing or devices) and turns the service's
 * { status, body } into a response.
 */
export async function runAccountAction(context, label, action, { recent = true } = {}) {
  const supabaseAdmin = adminClient(context.env);
  const auth = recent
    ? await requireRecentUser(context.request, supabaseAdmin)
    : await requireUser(context.request, supabaseAdmin);
  if (!auth.user) return auth.response;
  try {
    const { status, body } = await action(supabaseAdmin, auth.user, auth.claims);
    return jsonResponse(body, status);
  } catch (err) {
    console.error(`${label}: unexpected error:`, err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
