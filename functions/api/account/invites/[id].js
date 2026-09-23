import { createClient } from "@supabase/supabase-js";
import { requireUser, jsonResponse } from "../../../lib/user-auth.js";
import { getAccountForUser } from "../../../lib/accounts.js";

/**
 * Withdraws an outstanding invitation.
 *
 * Scoped to the caller's own account: the id alone must not be enough to
 * cancel someone else's invite, so the delete is filtered on account_id as
 * well and a miss reads as 404 rather than confirming the row exists.
 */
export async function onRequestDelete({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { user, response } = await requireUser(request, supabaseAdmin);
  if (!user) return response;

  try {
    const inviteId = Number(params.id);
    if (!Number.isInteger(inviteId)) {
      return jsonResponse({ error: "Invitation not found." }, 404);
    }

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`invites/[id]: user ${user.id} has no account_members row`);
      return jsonResponse({ error: "Internal error" }, 500);
    }
    if (account.role !== "owner") {
      return jsonResponse({ error: "Only the account owner can manage invitations." }, 403);
    }

    // Revoked rather than deleted: the row is the record that this token is
    // permanently spent, and member_invites_pending_uniq keys off exactly
    // this column to let the same address be re-invited.
    const { data: revoked, error } = await supabaseAdmin
      .from("member_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId)
      .eq("account_id", account.accountId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id");
    if (error) throw new Error(`member_invites revoke failed: ${error.message}`);
    if (!revoked || revoked.length === 0) {
      return jsonResponse({ error: "Invitation not found." }, 404);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("invites/[id]: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
