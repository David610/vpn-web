import { authenticateNode } from "../../lib/node-auth.js";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/agent/events?cursor=<opaque>&wait=<seconds, 0..30, default 25>
 *
 * Authenticated long-poll wake-up channel. Returns as soon as the node's
 * pending jobs, authorization snapshot (incl. entitlement) or lease
 * revocations/renewals changed since `cursor`, or after `wait` seconds.
 * The body is a HINT -- { reason, changed: ["jobs"|"authorizations"|"leases"],
 * cursor } -- never data: the agent still fetches the authoritative state from
 * the existing endpoints, and keeps a timed reconciliation as the fallback.
 *
 * Needs a long-lived process (env.AGENT_EVENT_HUB, provided by server/index.mjs).
 * On Cloudflare Pages it answers 501 so agents fall back to polling.
 */
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const DEFAULT_WAIT_S = 25;
const MAX_WAIT_S = 30;

function respond(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export async function onRequestGet({ env, request }) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const nodeId = await authenticateNode(request, db);
  if (!nodeId) return respond({ error: "Unauthorized" }, 401);

  const hub = env.AGENT_EVENT_HUB;
  if (!hub) return respond({ error: "Event channel unavailable on this deployment", fallback: "poll" }, 501, { "Retry-After": "600" });

  const url = new URL(request.url);
  const rawWait = url.searchParams.get("wait");
  let waitSeconds = DEFAULT_WAIT_S;
  if (rawWait !== null) {
    if (!/^\d{1,4}$/.test(rawWait)) return respond({ error: "wait must be a whole number of seconds" }, 400);
    waitSeconds = Math.min(Number(rawWait), MAX_WAIT_S);
  }
  const cursor = url.searchParams.get("cursor") || undefined;

  try {
    const result = await hub.wait(nodeId, cursor, { timeoutMs: waitSeconds * 1000, signal: request.signal });
    if (result.reason === "superseded") {
      return respond({ error: "Another connection from this node replaced this one" }, 409, { "Retry-After": "5" });
    }
    return respond({ reason: result.reason, changed: result.changed, cursor: result.cursor });
  } catch {
    return respond({ error: "Event channel temporarily unavailable" }, 503, { "Retry-After": "5" });
  }
}
