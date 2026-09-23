import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";

/**
 * Ingests one traffic sample from a node's provisioning agent.
 *
 * The agent reports sing-box's CUMULATIVE counters, not deltas. That choice
 * is what makes a dropped or failed report harmless: the next successful one
 * still carries the true running total, so a gap costs resolution but never
 * bytes. Differencing happens server-side in record_node_traffic, which also
 * folds the result into the daily rollup under a row lock so two overlapping
 * reports cannot both claim the same bytes.
 *
 * These are per-NODE totals. sing-box exposes no per-user counters in the
 * official build — see the migration's header comment and
 * docs/TRAFFIC_ACCOUNTING.md for why, and what it would take to get them.
 */
export async function onRequestPost({ env, request }) {
  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Byte counters are cumulative and can legitimately exceed 2^53 on a
    // busy node over a long uptime, but JSON numbers lose precision past
    // that. Reject rather than silently record a rounded figure; the agent
    // reports often enough that a counter this large means something is
    // wrong anyway.
    const counters = {
      bytes_up: body?.bytes_up,
      bytes_down: body?.bytes_down,
      connections_open: body?.connections_open,
    };
    for (const [field, value] of Object.entries(counters)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        return json({ error: `${field} must be a non-negative integer` }, 400);
      }
    }

    const sampledAt = typeof body?.sampled_at === "string" ? new Date(body.sampled_at) : null;
    if (!sampledAt || Number.isNaN(sampledAt.getTime())) {
      return json({ error: "sampled_at must be an RFC3339 timestamp" }, 400);
    }
    // A clock-skewed node must not write a sample far in the future: it
    // would become the baseline every later report differences against,
    // stalling the series until real time caught up.
    if (sampledAt.getTime() > Date.now() + 5 * 60_000) {
      return json({ error: "sampled_at is too far in the future" }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc("record_node_traffic", {
      p_node_id: nodeId,
      p_bytes_up: counters.bytes_up,
      p_bytes_down: counters.bytes_down,
      p_connections_open: counters.connections_open,
      p_sampled_at: sampledAt.toISOString(),
    });
    if (error) throw new Error(`record_node_traffic failed: ${error.message}`);

    // The RPC returns a single row; PostgREST surfaces set-returning
    // functions as an array.
    const result = Array.isArray(data) ? data[0] : data;
    return json(
      {
        ok: true,
        delta_up: result?.delta_up ?? 0,
        delta_down: result?.delta_down ?? 0,
        interval_seconds: result?.interval_seconds ?? null,
        counter_reset: Boolean(result?.counter_reset),
      },
      200
    );
  } catch (err) {
    console.error("agent/traffic: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
