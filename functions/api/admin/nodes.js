import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function classify(lastSeenAt) {
  if (!lastSeenAt) return "offline";
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 45_000) return "online";
  if (ageMs < 120_000) return "degraded";
  return "offline";
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const todayUtc = new Date().toISOString().slice(0, 10);
    const [
      { data, error },
      { data: samples, error: samplesError },
      { data: daily, error: dailyError },
    ] = await Promise.all([
      supabaseAdmin.from("nodes").select("node_id, last_seen_at, revoked_at"),
      // Two most recent samples per node would need a lateral join, which
      // PostgREST cannot express. The sample rate is one per node per poll
      // interval, so a bounded recent window is cheap and is trimmed to the
      // latest per node below.
      supabaseAdmin
        .from("node_traffic_samples")
        .select("node_id, delta_up, delta_down, interval_seconds, connections_open, sampled_at")
        .order("sampled_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("node_traffic_daily")
        .select("node_id, bytes_up, bytes_down")
        .eq("day", todayUtc),
    ]);
    if (error) throw new Error(`nodes query failed: ${error.message}`);
    if (samplesError) throw new Error(`node_traffic_samples query failed: ${samplesError.message}`);
    if (dailyError) throw new Error(`node_traffic_daily query failed: ${dailyError.message}`);

    const latestByNode = new Map();
    for (const s of samples ?? []) {
      if (!latestByNode.has(s.node_id)) latestByNode.set(s.node_id, s);
    }
    const dailyByNode = new Map((daily ?? []).map((d) => [d.node_id, d]));

    const nodes = data.map((n) => {
      const latest = latestByNode.get(n.node_id);
      const today = dailyByNode.get(n.node_id);
      // Throughput is the last sample's delta over the interval it covers.
      // A stale sample would report a figure that looks live but is not, so
      // anything older than two minutes reads as null rather than as zero —
      // "unknown" and "idle" are different states for an operator.
      const isFresh =
        latest && Date.now() - new Date(latest.sampled_at).getTime() < 120_000;
      const interval = latest?.interval_seconds;
      return {
        nodeId: n.node_id,
        status: n.revoked_at ? "revoked" : classify(n.last_seen_at),
        lastSeenAt: n.last_seen_at,
        revokedAt: n.revoked_at,
        traffic: {
          sampledAt: latest?.sampled_at ?? null,
          connectionsOpen: isFresh ? latest.connections_open : null,
          bpsUp: isFresh && interval ? Math.round((latest.delta_up * 8) / interval) : null,
          bpsDown: isFresh && interval ? Math.round((latest.delta_down * 8) / interval) : null,
          todayBytesUp: today?.bytes_up ?? 0,
          todayBytesDown: today?.bytes_down ?? 0,
        },
      };
    });

    return jsonResponse({ nodes });
  } catch (err) {
    console.error("admin/nodes: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
