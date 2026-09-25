import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "../../../../lib/admin-auth.js";
import { writeAdminAudit } from "../../../../lib/admin-audit.js";
import { getProviderAdapter } from "../../../../lib/provider-adapter.js";
import { getDnsAdapter, nodeHostname } from "../../../../lib/dns-adapter.js";
import { startReplaceNodeOperation, advanceOperation, DEFAULT_REPLACE_MAX_WAIT_HOURS } from "../../../../lib/fleet-operations.js";
import { fleetContext } from "../../../../lib/fleet-context.js";

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REPLACE_ELIGIBLE_STATES = new Set(["READY", "DEGRADED", "FAILED"]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Admin-initiated replace-node (spec 2026-09-25-fleet-phase12a). Provisions
 * a fresh node the same way POST /api/admin/nodes does, then hands the
 * combined workflow to REPLACE_NODE's saga: the reconciler (fleet-tick.js)
 * drains and retires the old node once the new one is verified READY. The
 * old node is validated eligible here but never written to by this route —
 * ordering safety belongs entirely to fleet-operations.js's DRAIN_OLD_NODE.
 */
export async function onRequestPost({ env, request, params }) {
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { admin, response } = await requireAdmin(request, supabaseAdmin);
  if (!admin) return response;
  if (admin.role === "readonly") {
    return jsonResponse({ error: "Read-only admins cannot perform this action" }, 403);
  }

  const oldNodeId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const newNodeId = typeof body?.newNodeId === "string" ? body.newNodeId.trim() : "";
  if (!NODE_ID_PATTERN.test(newNodeId)) {
    return jsonResponse({ error: "newNodeId must be lowercase alphanumeric/hyphen, 2-63 characters" }, 400);
  }
  if (newNodeId === oldNodeId) {
    return jsonResponse({ error: "newNodeId must differ from the node being replaced" }, 400);
  }
  const region = typeof body?.region === "string" && body.region ? body.region : null;
  if (!region) {
    return jsonResponse({ error: "region is required" }, 400);
  }
  let maxWaitHours = DEFAULT_REPLACE_MAX_WAIT_HOURS;
  if (body?.maxWaitHours !== undefined) {
    maxWaitHours = Number(body.maxWaitHours);
    // Must be a whole number: register_node_replace_operation's
    // p_max_wait_hours parameter is a Postgres integer, and a fractional
    // value would fail the RPC call with a cast error (a 500) instead of
    // this clean 400.
    if (!Number.isInteger(maxWaitHours) || maxWaitHours < 1 || maxWaitHours > 720) {
      return jsonResponse({ error: "maxWaitHours must be a whole number between 1 and 720" }, 400);
    }
  }

  try {
    const { data: oldNode, error: lookupError } = await supabaseAdmin
      .from("nodes")
      .select("node_id, role, location_id, lifecycle_state, provider")
      .eq("node_id", oldNodeId)
      .maybeSingle();
    if (lookupError) throw new Error(`nodes lookup failed: ${lookupError.message}`);
    if (!oldNode) return jsonResponse({ error: "Node not found" }, 404);
    if (!REPLACE_ELIGIBLE_STATES.has(oldNode.lifecycle_state)) {
      return jsonResponse({ error: `Cannot replace a node in state ${oldNode.lifecycle_state}` }, 409);
    }

    const provider = typeof body?.provider === "string" && body.provider ? body.provider : oldNode.provider;
    if (!provider) {
      return jsonResponse({ error: "provider is required (old node has none on record)" }, 400);
    }

    let hostname;
    try {
      getProviderAdapter(provider, env);
      hostname = nodeHostname(newNodeId, env);
      if (!env.FLEET_SINGBOX_VPN_VERSION) throw new Error("FLEET_SINGBOX_VPN_VERSION is not configured");
      getDnsAdapter(env);
    } catch (err) {
      console.error("admin/nodes/:id/replace: fleet provisioning not configured:", err.message);
      return jsonResponse({ error: `Provider ${provider} is not available` }, 400);
    }

    const { operation, error } = await startReplaceNodeOperation(supabaseAdmin, {
      newNodeId,
      role: oldNode.role,
      locationId: oldNode.location_id,
      provider,
      region,
      hostname,
      oldNodeId,
      maxWaitHours,
    });
    if (error) {
      if (error.code === "23505") {
        return jsonResponse(
          { error: "A replacement for this node is already in progress, or newNodeId already exists" },
          409
        );
      }
      if (error.code === "23503") {
        return jsonResponse({ error: "locationId does not exist" }, 400);
      }
      throw new Error(`register_node_replace_operation failed: ${error.message}`);
    }

    await writeAdminAudit(supabaseAdmin, {
      adminUserId: admin.userId,
      action: "admin.node_replace_initiated",
      targetType: "node",
      targetId: oldNodeId,
      metadata: { oldNodeId, newNodeId, operationId: operation.id, provider, region, maxWaitHours },
    });

    let progress = null;
    try {
      progress = await advanceOperation(fleetContext(supabaseAdmin, env), operation);
    } catch (err) {
      // Not an error for the caller: the reconciler resumes the operation.
      console.error("admin/nodes/:id/replace: inline advance failed:", err.message);
    }

    return jsonResponse({ ok: true, oldNodeId, newNodeId, hostname, operationId: operation.id, progress }, 202);
  } catch (err) {
    console.error("admin/nodes/:id/replace: unexpected error:", err.message);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}
