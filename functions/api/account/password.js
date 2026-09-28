import { createClient } from "@supabase/supabase-js";
import { requireRecentUser, jsonResponse } from "../../lib/user-auth.js";

export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { user, response } = await requireRecentUser(request, supabaseAdmin);
  if (!user) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 128) {
    return jsonResponse({ error: "Password must be between 12 and 128 characters." }, 400);
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
    if (error) {
      console.error("account/password: Supabase update failed:", error.message);
      return jsonResponse({ error: "Could not update password." }, 400);
    }

    // F-22: a stolen session should not survive its owner changing the
    // password specifically to invalidate it. `scope: "others"` revokes
    // every session for this user except the one making this request, so
    // the caller stays signed in on this device while every other
    // device/token is signed out. This uses admin.signOut(jwt, scope) with
    // the caller's own access token, not a per-user-id revocation (GoTrue's
    // admin API has no such call) — it works because "others" is scoped
    // relative to the session behind the supplied token.
    //
    // This does not close the gap for symmetric-key (HS256) Supabase
    // projects: those sessions' access tokens stay valid for their full
    // lifetime regardless of server-side revocation, since verification
    // never calls back to GoTrue. Closing that fully requires migrating to
    // asymmetric (RS256/ES256) signing keys so every verification path
    // checks live session state -- tracked separately, not done here.
    const authHeader = request.headers.get("Authorization");
    const currentAccessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (currentAccessToken) {
      const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(
        currentAccessToken,
        "others"
      );
      if (signOutError) {
        console.error("account/password: sign-out-others failed:", signOutError.message);
      }
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("account/password: failed:", err.message);
    return jsonResponse({ error: "Could not update password." }, 500);
  }
}
