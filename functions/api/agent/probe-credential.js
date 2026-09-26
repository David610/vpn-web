import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { validProbeUri } from "../../lib/protocol-health.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * A node publishes the share links of its own reserved probe user
 * (`arcana-probe`, created locally via vpn-admin). Stored service-role
 * only; handed to peer agents by probe-targets.js, never to admins or
 * users. The URIs are never logged.
 */
export async function onRequestPost({ env, request }) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabase);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const realityUri = body?.reality_uri ?? null;
  const hysteria2Uri = body?.hysteria2_uri ?? null;
  if (realityUri !== null && !validProbeUri(realityUri, "vless")) return json({ error: "Invalid reality_uri" }, 400);
  if (hysteria2Uri !== null && !validProbeUri(hysteria2Uri, "hysteria2")) return json({ error: "Invalid hysteria2_uri" }, 400);
  if (realityUri === null && hysteria2Uri === null) return json({ error: "No probe URI" }, 400);

  const { error } = await supabase.from("node_probe_credentials").upsert(
    { node_id: nodeId, reality_uri: realityUri, hysteria2_uri: hysteria2Uri, updated_at: new Date().toISOString() },
    { onConflict: "node_id" }
  );
  if (error) {
    console.error("agent/probe-credential: upsert failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }
  return json({ ok: true });
}
