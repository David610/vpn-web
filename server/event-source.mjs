import { createClient } from "@supabase/supabase-js";
import { createEventHub } from "../functions/lib/agent-events.js";

async function call(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed`);
  return data ?? [];
}

export function createSupabaseEventHub({ db, ...options }) {
  return createEventHub({
    fetchWakeTokens: async (nodeIds) => new Map((await call(db, "agent_wake_tokens", { p_node_ids: nodeIds })).map((row) => [
      row.node_id,
      { jobs: String(row.jobs_token ?? "0:0"), auth: Number(row.auth_revision ?? 0), lease: String(row.lease_token ?? "") },
    ])),
    fetchEntitlementTokens: async (nodeIds) => new Map(
      (await call(db, "agent_entitlement_tokens", { p_node_ids: nodeIds })).map((row) => [row.node_id, String(row.entitlement_token ?? "")]),
    ),
    ...options,
  });
}

export function hubFromEnv(env, options = {}) {
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return createSupabaseEventHub({
    db,
    intervalMs: Number(env.EVENT_POLL_INTERVAL_MS ?? 1_000),
    entitlementIntervalMs: Number(env.EVENT_ENTITLEMENT_INTERVAL_MS ?? 5_000),
    ...options,
  });
}
