import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../lib/user-auth.js";
import { getAccountForUser } from "../../lib/accounts.js";

/**
 * Lists the caller's account's connection profiles, for the device
 * reassignment dropdown. Read-only.
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
      console.error(`account/connection-profiles: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("connection_profiles")
      .select("id, name, enabled, routing_mode, preferred_entry_location_id, preferred_exit_location_id, auto_failover")
      .eq("account_id", account.accountId)
      .order("name", { ascending: true });
    if (profilesError) throw new Error(`connection_profiles lookup failed: ${profilesError.message}`);

    return jsonResponse({
      profiles: (profiles ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        routingMode: p.routing_mode,
        preferredEntryLocationId: p.preferred_entry_location_id,
        preferredExitLocationId: p.preferred_exit_location_id,
        autoFailover: p.auto_failover,
      })),
    });
  } catch (err) {
    console.error("account/connection-profiles: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
