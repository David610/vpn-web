import { createClient } from "@supabase/supabase-js";
import { isValidFleetTickSecret } from "../../lib/fleet-context.js";
import { runRetention } from "../../lib/retention.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Data-retention heartbeat (F-18 / H-02). Same shape as
 * functions/api/internal/fleet-tick.js: called by Supabase pg_cron (via
 * pg_net) with a shared secret, on whatever schedule an operator wires up
 * (daily is enough; nothing here is time-critical). Every step in
 * runRetention() is a delete/update keyed off an age cutoff, so calling
 * this endpoint concurrently or repeatedly is always safe -- a second call
 * simply matches zero additional rows, the same idempotence fleet-tick's
 * SKIP LOCKED leasing relies on for operations.
 *
 * Deliberately a separate secret/endpoint from fleet-tick rather than
 * folded into it: retention is not on fleet-tick's once-a-minute
 * criticality path, and keeping it separate means a slow retention pass
 * can never delay fleet operation leasing.
 */
export async function onRequestPost({ env, request }) {
  const secret = env.RETENTION_TICK_SECRET || env.FLEET_TICK_SECRET;
  if (!(await isValidFleetTickSecret(request.headers.get("X-Retention-Tick-Secret"), secret))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const results = await runRetention(supabaseAdmin, env);
  return json({ results });
}
