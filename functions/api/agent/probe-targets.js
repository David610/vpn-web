import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { choosePeers } from "../../lib/protocol-health.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Only nodes in these states probe or get probed. A QUARANTINED/RETIRED
// node gets no peer credentials (it may be compromised), and nobody wastes
// probes on nodes an admin has taken out of service.
const PROBING_STATES = ["WARMING_UP", "READY", "DEGRADED"];

/**
 * Peer probe targets for the calling agent: up to PROBE_PEER_FANOUT other
 * active nodes (rotating hourly), each with its expected public IPv4 and
 * its reserved probe credential links.
 */
export async function onRequestGet({ env, request }) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabase);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  const { data: self } = await supabase.from("nodes").select("lifecycle_state").eq("node_id", nodeId).maybeSingle();
  if (!self || !PROBING_STATES.includes(self.lifecycle_state)) return json({ targets: [] });

  const { data: peers, error } = await supabase
    .from("nodes")
    .select("node_id, ip_address")
    .in("lifecycle_state", PROBING_STATES)
    .is("revoked_at", null)
    .neq("node_id", nodeId);
  if (error) {
    console.error("agent/probe-targets: node list failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }
  const chosen = choosePeers(nodeId, peers ?? [], Date.now());
  if (chosen.length === 0) return json({ targets: [] });

  const { data: creds, error: credError } = await supabase
    .from("node_probe_credentials")
    .select("node_id, reality_uri, hysteria2_uri")
    .in("node_id", chosen.map((p) => p.node_id));
  if (credError) {
    console.error("agent/probe-targets: credential read failed:", credError.message);
    return json({ error: "Internal error" }, 500);
  }
  const byId = new Map((creds ?? []).map((c) => [c.node_id, c]));
  const targets = chosen
    .filter((p) => byId.has(p.node_id))
    .map((p) => ({
      node_id: p.node_id,
      expected_ipv4: p.ip_address ?? null,
      reality_uri: byId.get(p.node_id).reality_uri,
      hysteria2_uri: byId.get(p.node_id).hysteria2_uri,
    }));
  return json({ targets });
}
