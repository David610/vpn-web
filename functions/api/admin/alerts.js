import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../lib/admin-auth.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function onRequestGet({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;

  try {
    const [{ data: stored, error: alertError }, { data: nodes, error: nodeError }] =
      await Promise.all([
        supabaseAdmin
          .from("operational_alerts")
          .select("id, alert_type, severity, status, node_id, vpn_account_id, message, created_at, resolved_at")
          .order("created_at", { ascending: false })
          .limit(200),
        supabaseAdmin.from("nodes").select("node_id, last_seen_at, revoked_at"),
      ]);
    if (alertError) throw new Error(`alerts query failed: ${alertError.message}`);
    if (nodeError) throw new Error(`nodes query failed: ${nodeError.message}`);

    const now = Date.now();
    const derived = (nodes ?? [])
      .filter(
        (n) =>
          !n.revoked_at &&
          (!n.last_seen_at || now - new Date(n.last_seen_at).getTime() >= 180_000)
      )
      .map((n) => ({
        id: `node-offline:${n.node_id}`,
        alertType: "node_offline",
        severity: "critical",
        status: "open",
        nodeId: n.node_id,
        vpnAccountId: null,
        message: `Node ${n.node_id} has missed multiple heartbeats`,
        createdAt: n.last_seen_at,
        resolvedAt: null,
        derived: true,
      }));

    return json({
      alerts: [
        ...derived,
        ...(stored ?? []).map((a) => ({
          id: String(a.id),
          alertType: a.alert_type,
          severity: a.severity,
          status: a.status,
          nodeId: a.node_id,
          vpnAccountId: a.vpn_account_id,
          message: a.message,
          createdAt: a.created_at,
          resolvedAt: a.resolved_at,
          derived: false,
        })),
      ],
    });
  } catch (err) {
    console.error("admin/alerts: failed:", err.message);
    return json({ error: "Internal error" }, 500);
  }
}
