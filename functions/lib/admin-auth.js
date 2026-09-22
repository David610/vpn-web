/**
 * Authenticates an admin-dashboard request via the caller's Supabase
 * session (Bearer access token, same shape as every customer-facing
 * route — see functions/api/cancel-subscription.js), then checks
 * admin_users for a role. Returns null for any failure (missing header,
 * invalid token, or a real user who is simply not an admin) — the
 * caller is responsible for turning that into a 401, via requireAdmin
 * below for every route in this plan.
 *
 * @param {Request} request
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @returns {Promise<{ userId: string, role: string } | null>}
 */
export async function authenticateAdmin(request, supabaseAdmin) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return null;

  const {
    data: { user },
    error: tokenError,
  } = await supabaseAdmin.auth.getUser(accessToken);
  if (tokenError || !user) return null;

  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("authenticateAdmin: lookup failed:", error.message);
    return null;
  }
  if (!data) return null;
  return { userId: user.id, role: data.role };
}

/**
 * Convenience wrapper every /api/admin/* route calls first:
 *   const { admin, response } = await requireAdmin(request, supabaseAdmin);
 *   if (!admin) return response;
 * Keeps the 401 body/headers identical across every admin route instead
 * of each one re-implementing it.
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
  return { admin, response: null };
}
