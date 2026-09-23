import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import { loadCustomerDashboardState } from "../../lib/dashboard-state.js";

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const state = await loadCustomerDashboardState(supabaseAdmin, user);
    if (!state) {
      console.error(`account: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }
    return jsonResponse(state.overview);
  } catch (err) {
    console.error("account: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
