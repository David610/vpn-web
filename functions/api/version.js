import { createClient } from "@supabase/supabase-js";

// The most recent migration file at the time this endpoint was written.
// Bump this string (and MIN_SCHEMA_MARKER_TABLE below, if the migration
// that motivated the bump adds a new table) whenever a migration ships that
// the deployed code depends on, so `/api/version` keeps telling the truth
// about what schema this build expects.
const EXPECTED_LATEST_MIGRATION = "20260930010000_route_directory_state_rls";

// A table introduced by a recent migration
// (20260930000000_node_probe_results.sql). If the deployed database is
// missing it, the running code (built against a newer migration set than
// the database has actually applied) is likely to fail on any code path
// that touches node probing. This is intentionally a cheap, single-purpose
// smoke check, not a full migration-vs-code diff: it exists to turn
// "random 500s after a code deploy that outran migrations" into a visible,
// explicit signal on this endpoint.
const MIN_SCHEMA_MARKER_TABLE = "node_probe_results";

async function checkSchemaMarker(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: null, reason: "supabase_not_configured" };
  }
  try {
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await supabaseAdmin.from(MIN_SCHEMA_MARKER_TABLE).select("id").limit(1);
    if (error) {
      // Postgres 42P01 = undefined_table; PostgREST surfaces missing
      // tables/columns as a 404-ish PGRST error too depending on version.
      return { ok: false, reason: error.message };
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function onRequestGet({ env }) {
  const schema = await checkSchemaMarker(env);

  const body = {
    // Cloudflare Pages sets these on every build; they are undefined for a
    // local `next dev`/`wrangler pages dev` run, which is expected.
    commit_sha: env.CF_PAGES_COMMIT_SHA || null,
    branch: env.CF_PAGES_BRANCH || null,
    deployed_at: env.CF_PAGES_URL ? new Date().toISOString() : null,
    expected_latest_migration: EXPECTED_LATEST_MIGRATION,
    schema_marker_table: MIN_SCHEMA_MARKER_TABLE,
    schema_check: schema.ok === null ? "unknown" : schema.ok ? "ok" : "behind_or_unreachable",
    schema_check_detail: schema.reason,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
