import { createClient } from "@supabase/supabase-js";

/**
 * Public list of the locations Arcana can actually serve right now, for the
 * website's Locations section.
 *
 * A location is listed only when it is enabled AND at least one READY node
 * sits in it — an enabled location with no serving node would be an
 * advertised place nobody can connect to. Only display metadata leaves this
 * endpoint: no node ids, addresses, providers or counts.
 */
export async function onRequestGet({ env }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: nodes, error: nodesError } = await supabaseAdmin
      .from("nodes")
      .select("location_id")
      .eq("lifecycle_state", "READY");
    if (nodesError) throw new Error(`nodes lookup failed: ${nodesError.message}`);

    const serving = [...new Set((nodes ?? []).map((n) => n.location_id).filter(Boolean))];
    if (serving.length === 0) return publicJson({ locations: [] });

    const { data: locations, error: locationsError } = await supabaseAdmin
      .from("locations")
      .select("id, country_code, city, display_name")
      .eq("enabled", true)
      .in("id", serving)
      .order("display_name", { ascending: true });
    if (locationsError) throw new Error(`locations lookup failed: ${locationsError.message}`);

    return publicJson({
      locations: (locations ?? []).map((l) => ({
        id: l.id,
        countryCode: l.country_code,
        city: l.city ?? null,
        name: l.display_name,
      })),
    });
  } catch (err) {
    console.error("locations: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}

function publicJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Non-personal product metadata: a short shared cache keeps the landing
      // page from hitting the database on every view.
      "Cache-Control": "public, max-age=300",
    },
  });
}
