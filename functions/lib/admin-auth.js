/**
 * Authenticates an admin-dashboard request via the caller's Supabase
 * session (Bearer access token, same shape as every customer-facing
 * route — see functions/api/cancel-subscription.js), then checks
 * admin_users for a role. Returns null for any failure (missing header,
 * invalid token, or a real user who is simply not an admin) — the
 * caller is responsible for turning that into a 401, via requireAdmin
 * below for every route in this plan.
 *
 * Uses getClaims() rather than getUser() because the admin gate needs the
 * token's `aal` (authenticator assurance level) claim, which the user
 * record does not carry. getClaims verifies the JWT signature locally via
 * WebCrypto when the project uses asymmetric signing keys, and falls back
 * to a getUser() round-trip against the auth server for symmetric ones;
 * either path establishes authenticity before we read any claim.
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @returns {Promise<{ userId: string, role: string, aal: string } | null>}
 */
export async function authenticateAdmin(request, supabaseAdmin) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return null;

  const { data: claimsData, error: tokenError } =
    await supabaseAdmin.auth.getClaims(accessToken);
  if (tokenError || !claimsData?.claims?.sub) return null;

  const userId = claimsData.claims.sub;
  // Supabase issues `aal1` for password-only sessions and `aal2` once a
  // second factor has been verified in that session. The claim is always
  // present; treat anything unexpected as not-stepped-up.
  const aal = claimsData.claims.aal ?? "aal1";

  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("authenticateAdmin: lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { userId, role: data.role, aal };
}

/**
 * Convenience wrapper every /api/admin/* route calls first:
 *   const { admin, response } = await requireAdmin(request, supabaseAdmin);
 *   if (!admin) return response;
 * Keeps the 401 body/headers identical across every admin route instead
 * of each one re-implementing it.
 *
 * Every admin route requires a stepped-up (`aal2`) session — a stolen or
 * phished admin password alone must not reach customer data. Admins who
 * have not yet enrolled a factor are refused here too, and enroll through
 * the Supabase SDK directly from the browser (supabase.auth.mfa.enroll),
 * which never passes through these routes; there is therefore no
 * bootstrapping hole to keep open, and no grace path to forget to close.
 *
 * The mfa_required refusal is a 403 with a machine-readable `code` so the
 * dashboard can tell "you are an admin who needs to step up" apart from
 * the 401 "you are not an admin" — the two need very different UI.
 */
export async function requireAdmin(request, supabaseAdmin) {
  const admin = await authenticateAdmin(request, supabaseAdmin);
  if (!admin) {
    return {
      admin: null,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  if (admin.aal !== "aal2") {
    return {
      admin: null,
      response: new Response(
        JSON.stringify({
          error: "Multi-factor authentication required.",
          code: "mfa_required",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
    };
  }
  return { admin, response: null };
}
