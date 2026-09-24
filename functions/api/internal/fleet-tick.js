import { createClient } from "@supabase/supabase-js";
import { advanceOperation } from "../../lib/fleet-operations.js";
import { fleetContext, isValidFleetTickSecret } from "../../lib/fleet-context.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const BATCH = 10;
// Longer than one tick's worst case (a createInstance call plus probes),
// short enough that a crashed invocation's operations resume next minute.
const LEASE_SECONDS = 120;

/**
 * The fleet reconciler's heartbeat. Called once a minute by Supabase
 * pg_cron (via pg_net, see scripts/setup-fleet-cron.mjs) with the shared
 * FLEET_TICK_SECRET; leases due operations and advances each as far as it
 * can go. Safe to call concurrently or repeatedly -- leasing is atomic and
 * every step is idempotent.
 */
export async function onRequestPost({ env, request }) {
  if (!(await isValidFleetTickSecret(request.headers.get("X-Fleet-Tick-Secret"), env.FLEET_TICK_SECRET))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: ops, error } = await supabaseAdmin.rpc("lease_fleet_operations", {
    p_limit: BATCH,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    console.error("fleet-tick: lease failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }

  const ctx = fleetContext(supabaseAdmin, env);
  const results = [];
  for (const op of ops ?? []) {
    try {
      const result = await advanceOperation(ctx, op);
      results.push({ id: op.id, type: op.type, nodeId: op.node_id, ...result });
    } catch (err) {
      // Infrastructure failure (DB unreachable mid-step): the lease lapses
      // and the next tick retries from the last persisted step.
      console.error("fleet-tick: advance failed:", op.id, err.message);
      results.push({ id: op.id, type: op.type, nodeId: op.node_id, status: "ERROR" });
    }
  }
  return json({ leased: results.length, results });
}
