import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser, getEffectiveEntitlement } from "../../lib/accounts.js";
import { buildAccountOverview } from "../../lib/account-overview.js";

/**
 * The caller's account: members, live invites, and effective seat capacity.
 * Mutating routes independently enforce owner/member permissions.
 */
export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`account: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
    const overview = await buildAccountOverview(
      supabaseAdmin,
      user,
      account,
      entitlement
    );

    return jsonResponse(overview);
  } catch (err) {
    console.error("account: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
