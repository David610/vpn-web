import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import {
  getAccountForUser,
  getEffectiveEntitlement,
  INCLUDED_SEATS,
} from "../../../../lib/accounts.js";
import { syncAccountProvisioningToEntitlement } from "../../../../lib/provision-entitlement.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") return json({ error: "Read-only admins cannot grant access." }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const seatLimit = Number.isInteger(body?.seat_limit) ? body.seat_limit : INCLUDED_SEATS;
  const expiresAt = body?.expires_at == null ? null : String(body.expires_at);
  if (!reason || reason.length > 500) return json({ error: "A reason is required (max 500 characters)." }, 400);
  if (seatLimit < 1 || seatLimit > 53) return json({ error: "Seat limit must be between 1 and 53." }, 400);
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    return json({ error: "Expiry must be a future timestamp." }, 400);
  }

  try {
    const account = await getAccountForUser(supabaseAdmin, params.id);
    if (!account) return json({ error: "Customer account not found." }, 404);

    const [{ count: memberCount, error: memberError }, { data: invites, error: inviteError }] =
      await Promise.all([
        supabaseAdmin
          .from("account_members")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.accountId),
        supabaseAdmin
          .from("member_invites")
          .select("id")
          .eq("account_id", account.accountId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString()),
      ]);
    if (memberError) throw new Error(`member count failed: ${memberError.message}`);
    if (inviteError) throw new Error(`invite lookup failed: ${inviteError.message}`);
    const seatsUsed = (memberCount ?? 0) + (invites?.length ?? 0);
    if (seatLimit < seatsUsed) {
      return json({ error: `This account already uses ${seatsUsed} seats.` }, 409);
    }

    // F-39 round 2: the admin_entitlements insert and its admin_audit_log
    // row commit together in a single RPC (see
    // 20261010000000_admin_audit_transactional_round2.sql), so a crash
    // between them can no longer leave an unaudited grant or an audit row
    // for a grant that never happened.
    const { data: grant, error: grantError } = await supabaseAdmin.rpc(
      "admin_grant_entitlement_with_audit",
      {
        p_account_id: account.accountId,
        p_expires_at: expiresAt,
        p_seat_limit: seatLimit,
        p_reason: reason,
        p_admin_user_id: admin.userId,
        p_audit_metadata: { target_user_id: params.id },
      }
    );
    if (grantError) throw new Error(`admin entitlement insert failed: ${grantError.message}`);

    // Recompute from all trusted sources after the insert. This preserves a
    // longer paid period or another support grant, and correctly maps a
    // no-expiry grant to CLEAR_EXPIRY rather than a fake far-future date.
    const entitlement = await getEffectiveEntitlement(supabaseAdmin, account.accountId);
    if (!entitlement) {
      throw new Error("grant was inserted but no effective entitlement could be resolved");
    }
    await syncAccountProvisioningToEntitlement(
      supabaseAdmin,
      account.accountId,
      entitlement,
      `admin-grant:${grant.id}`,
      env
    );

    return json({ grant }, 201);
  } catch (err) {
    console.error("admin/customers/:id/grant: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
