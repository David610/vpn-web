import { createClient } from "@supabase/supabase-js";
import { authenticateNode } from "../../lib/node-auth.js";
import { BOOTSTRAP_STAGES } from "../../lib/node-bootstrap.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const STATUSES = new Set(["RUNNING", "OK", "FAILED"]);
const VALID_TRANSPORTS = new Set(["vless-reality", "hysteria2"]);

function nonEmptyString(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Validates an agent-reported transport object (ADR-0002 sub-project A)
 * into the exact nodes.* columns it maps to, or null if any required
 * field for its declared transport is missing/malformed -- a partial or
 * wrong report is dropped silently rather than failing the whole
 * bootstrap-status update, since stage/status/message are the load-
 * bearing part of this endpoint and must never be blocked by an agent
 * build that gets this new, optional field wrong.
 */
function validateTransport(transport) {
  if (!transport || typeof transport !== "object") return null;
  if (!VALID_TRANSPORTS.has(transport.transport)) return null;
  const port = transport.server_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const tlsServerName = nonEmptyString(transport.tls_server_name, 253);
  if (!tlsServerName) return null;

  const fields = { transport: transport.transport, transport_port: port, tls_server_name: tlsServerName };
  if (transport.transport === "vless-reality") {
    const realityPublicKey = nonEmptyString(transport.reality_public_key, 128);
    const realityShortId = nonEmptyString(transport.reality_short_id, 32);
    const realityFingerprint = nonEmptyString(transport.reality_fingerprint, 32);
    const vlessFlow = nonEmptyString(transport.vless_flow, 64);
    if (!realityPublicKey || !realityShortId || !realityFingerprint || !vlessFlow) return null;
    return {
      ...fields,
      reality_public_key: realityPublicKey,
      reality_short_id: realityShortId,
      reality_fingerprint: realityFingerprint,
      vless_flow: vlessFlow,
    };
  }
  // hysteria2: only the shared fields are required; hysteria2_obfs_type is optional.
  const obfsType = nonEmptyString(transport.hysteria2_obfs_type, 32);
  return obfsType ? { ...fields, hysteria2_obfs_type: obfsType } : fields;
}

/**
 * Progress report from a node's bootstrap script (functions/lib/
 * node-bootstrap.js), authenticated with the node's own permanent key --
 * so only stages after ENROLL are ever reported. Feeds the CREATE_NODE
 * operation's AWAIT_BOOTSTRAP step and the admin fleet view.
 */
export async function onRequestPost({ env, request }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const nodeId = await authenticateNode(request, supabaseAdmin);
  if (!nodeId) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!BOOTSTRAP_STAGES.includes(body?.stage) || !STATUSES.has(body?.status)) {
    return json({ error: "stage/status invalid" }, 400);
  }
  // Same character whitelist the script applies; enforced again here since
  // this lands in an admin UI.
  const message =
    typeof body.message === "string"
      ? body.message.replace(/[^A-Za-z0-9 _.,:/()=+-]/g, "").slice(0, 400)
      : null;

  const update = {
    bootstrap_stage: body.stage,
    bootstrap_status: body.status,
    bootstrap_message: message,
    bootstrap_updated_at: new Date().toISOString(),
  };
  const transport = validateTransport(body.transport);
  if (transport) Object.assign(update, transport);

  const { error } = await supabaseAdmin.from("nodes").update(update).eq("node_id", nodeId);
  if (error) {
    console.error("agent/bootstrap-status: update failed:", error.message);
    return json({ error: "Internal error" }, 500);
  }
  return json({ ok: true });
}
