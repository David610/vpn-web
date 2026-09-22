/**
 * Bearer-token authentication for customer-facing routes, mirroring
 * requireAdmin's shape in functions/lib/admin-auth.js:
 *
 *   const { user, response } = await requireUser(request, supabaseAdmin);
 *   if (!user) return response;
 *
 * getUser() rather than getClaims() because these routes need only the
 * caller's identity — there is no assurance-level requirement on customer
 * endpoints, unlike the admin ones.
 */
export async function requireUser(request, supabaseAdmin) {
  const unauthorized = (message) => ({
    user: null,
    response: new Response(JSON.stringify({ error: message }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  });

  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return unauthorized("Authorization required");

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !user) return unauthorized("Invalid or expired token");

  return { user, response: null };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
