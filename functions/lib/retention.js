// Data retention (F-18 / H-02 / audit section 15). Nothing here was pruned
// before this file existed: vpn_leases, stripe_events payloads,
// provisioning_jobs, node_traffic_samples, telegram_link_codes, revoked
// devices' metadata and resolved operational_alerts all grew forever.
//
// Every function below:
//  - is safe to call repeatedly / concurrently (delete/update by a cutoff
//    timestamp is naturally idempotent -- a second run simply matches zero
//    additional rows), the same property fleet-tick's SKIP LOCKED leasing
//    relies on elsewhere in this codebase;
//  - takes its window from an env var with a safe, documented default, so
//    an operator can tune retention without a code change;
//  - never throws past its own boundary -- a failure in one table's
//    pruning must not stop the others (mirrors fleet-tick.js's per-step
//    try/catch around autoReplaceFailedNodes/autoScaleFullLocations);
//  - returns a small summary object for the caller to log/aggregate.
//
// None of this is wired to run automatically inside migrations -- it is
// called from functions/api/internal/retention-tick.js, the same
// shared-secret-gated, pg_cron-invoked pattern as fleet-tick.

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function envInt(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * vpn_leases (managed-auth connection records, ADR-0003) are pseudonymous
 * but still a connection history (audit section 15 flags this explicitly).
 * Default: delete rows older than 30 days.
 */
export async function pruneVpnLeases(supabase, env) {
  const days = envInt(env, "VPN_LEASE_RETENTION_DAYS", 30);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("vpn_leases")
    .delete({ count: "exact" })
    .lt("created_at", cutoff);
  if (error) {
    console.error("retention: pruneVpnLeases failed:", error.message);
    return { table: "vpn_leases", error: error.message };
  }
  return { table: "vpn_leases", deleted: count ?? 0, cutoffDays: days };
}

/**
 * stripe_events.payload holds the FULL webhook body (customer name, email,
 * address, amounts -- audit section 15) forever. The event id and
 * processed_at are what idempotent webhook processing actually needs to
 * keep, so those stay; the payload itself is dropped, not the row.
 * Default: 90 days after the event was recorded.
 */
export async function pruneStripeEventPayloads(supabase, env) {
  const days = envInt(env, "STRIPE_EVENT_PAYLOAD_RETENTION_DAYS", 90);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("stripe_events")
    .update({ payload: {} }, { count: "exact" })
    .lt("created_at", cutoff);
  if (error) {
    console.error("retention: pruneStripeEventPayloads failed:", error.message);
    return { table: "stripe_events", error: error.message };
  }
  return { table: "stripe_events", trimmed: count ?? 0, cutoffDays: days };
}

/**
 * provisioning_jobs: terminal (done/failed) jobs older than the window are
 * deleted outright. Pending/claimed jobs are never touched here regardless
 * of age -- a stuck `claimed` job (F-09) is an operational problem to
 * surface, not silently delete.
 */
export async function pruneProvisioningJobs(supabase, env) {
  const days = envInt(env, "PROVISIONING_JOB_RETENTION_DAYS", 90);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("provisioning_jobs")
    .delete({ count: "exact" })
    .in("status", ["done", "failed"])
    .lt("completed_at", cutoff);
  if (error) {
    console.error("retention: pruneProvisioningJobs failed:", error.message);
    return { table: "provisioning_jobs", error: error.message };
  }
  return { table: "provisioning_jobs", deleted: count ?? 0, cutoffDays: days };
}

/**
 * node_traffic_samples: raw 15s-resolution samples are already folded into
 * node_traffic_daily at write time (record_node_traffic()), so once a
 * sample is old enough that nobody needs sub-day resolution for it, the
 * raw row is pure bloat (~5,760 rows/day/node per the audit). Delete
 * (not "roll up" -- the rollup already happened) samples older than the
 * window.
 */
export async function pruneNodeTrafficSamples(supabase, env) {
  const days = envInt(env, "NODE_TRAFFIC_SAMPLE_RETENTION_DAYS", 7);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("node_traffic_samples")
    .delete({ count: "exact" })
    .lt("sampled_at", cutoff);
  if (error) {
    console.error("retention: pruneNodeTrafficSamples failed:", error.message);
    return { table: "node_traffic_samples", error: error.message };
  }
  return { table: "node_traffic_samples", deleted: count ?? 0, cutoffDays: days };
}

/**
 * telegram_link_codes: short-lived by design (10 min TTL) but expired/
 * consumed rows were never deleted. Default: drop anything whose
 * expires_at has passed by more than a day (a little slack in case a
 * legitimate late consumption check runs against it).
 */
export async function pruneTelegramLinkCodes(supabase, env) {
  const days = envInt(env, "TELEGRAM_LINK_CODE_RETENTION_DAYS", 1);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("telegram_link_codes")
    .delete({ count: "exact" })
    .lt("expires_at", cutoff);
  if (error) {
    console.error("retention: pruneTelegramLinkCodes failed:", error.message);
    return { table: "telegram_link_codes", error: error.message };
  }
  return { table: "telegram_link_codes", deleted: count ?? 0, cutoffDays: days };
}

/**
 * node_revisions: append-only by design (rollback/audit history), but
 * "keep every revision forever" was never a stated requirement -- only the
 * most recent N need to stay reachable for rollback. Keeps the latest
 * NODE_REVISIONS_KEEP (default 2) per node, deletes the rest. Per-node
 * because revision numbers are per-node (node_revisions_node_id_revision_uniq).
 */
export async function pruneNodeRevisions(supabase, env) {
  const keep = envInt(env, "NODE_REVISIONS_KEEP", 2);
  const { data: nodeIds, error: nodeError } = await supabase
    .from("node_revisions")
    .select("node_id")
    .limit(10000);
  if (nodeError) {
    console.error("retention: pruneNodeRevisions node lookup failed:", nodeError.message);
    return { table: "node_revisions", error: nodeError.message };
  }
  const distinctNodeIds = [...new Set((nodeIds ?? []).map((r) => r.node_id))];
  let deleted = 0;
  for (const nodeId of distinctNodeIds) {
    const { data: revisions, error: revError } = await supabase
      .from("node_revisions")
      .select("id, revision")
      .eq("node_id", nodeId)
      .order("revision", { ascending: false });
    if (revError) {
      console.error(`retention: pruneNodeRevisions revision lookup failed for ${nodeId}:`, revError.message);
      continue;
    }
    const toDelete = (revisions ?? []).slice(keep).map((r) => r.id);
    if (toDelete.length === 0) continue;
    const { error: delError, count } = await supabase
      .from("node_revisions")
      .delete({ count: "exact" })
      .in("id", toDelete);
    if (delError) {
      console.error(`retention: pruneNodeRevisions delete failed for ${nodeId}:`, delError.message);
      continue;
    }
    deleted += count ?? toDelete.length;
  }
  return { table: "node_revisions", deleted, keepPerNode: keep };
}

/**
 * Revoked devices keep their row forever (FK targets from vpn_accounts,
 * provisioning_jobs, etc. -- deleting the row is out of scope here), but
 * there's no reason platform/last_seen_at metadata about a device nobody
 * uses anymore needs to survive indefinitely. `name` is NOT NULL, so it is
 * replaced with a neutral placeholder rather than nulled.
 * Default: clear metadata for devices revoked more than 90 days ago.
 * Idempotent: only touches rows whose name isn't already the placeholder.
 */
const REVOKED_DEVICE_PLACEHOLDER_NAME = "(revoked device — details cleared)";

export async function clearStaleRevokedDeviceMetadata(supabase, env) {
  const days = envInt(env, "REVOKED_DEVICE_RETENTION_DAYS", 90);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("devices")
    .update({ name: REVOKED_DEVICE_PLACEHOLDER_NAME, platform: null }, { count: "exact" })
    .eq("status", "REVOKED")
    .lt("last_seen_at", cutoff)
    .neq("name", REVOKED_DEVICE_PLACEHOLDER_NAME);
  if (error) {
    console.error("retention: clearStaleRevokedDeviceMetadata failed:", error.message);
    return { table: "devices", error: error.message };
  }
  return { table: "devices", cleared: count ?? 0, cutoffDays: days };
}

/**
 * operational_alerts: resolved alerts are ops noise past a certain age.
 * Default: delete resolved alerts older than 30 days. Open alerts are
 * never touched here.
 */
export async function pruneOperationalAlerts(supabase, env) {
  const days = envInt(env, "OPERATIONAL_ALERT_RETENTION_DAYS", 30);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("operational_alerts")
    .delete({ count: "exact" })
    .eq("status", "resolved")
    .lt("resolved_at", cutoff);
  if (error) {
    console.error("retention: pruneOperationalAlerts failed:", error.message);
    return { table: "operational_alerts", error: error.message };
  }
  return { table: "operational_alerts", deleted: count ?? 0, cutoffDays: days };
}

export async function pruneCompatibilityAuthorizations(supabase, env) {
  const days = envInt(env, "COMPATIBILITY_AUTH_RETENTION_DAYS", 7);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase.from("compatibility_authorizations")
    .delete({ count: "exact" }).eq("revoked", true).lt("updated_at", cutoff);
  if (error) return { table: "compatibility_authorizations", error: error.message };
  return { table: "compatibility_authorizations", deleted: count ?? 0, cutoffDays: days };
}

/**
 * rate_limit_buckets are abuse-throttling counters, only meaningful for the
 * length of their window (minutes). Keys are keyed hashes (see
 * rate-limit.js), but rows written before that change still carry raw emails
 * and client IPs, so a short fixed retention also clears them out.
 * Default: delete counters whose window started more than 1 day ago.
 */
export async function pruneRateLimitBuckets(supabase, env) {
  const days = envInt(env, "RATE_LIMIT_BUCKET_RETENTION_DAYS", 1);
  const cutoff = daysAgoIso(days);
  const { error, count } = await supabase
    .from("rate_limit_buckets")
    .delete({ count: "exact" })
    .lt("window_start", cutoff);
  if (error) {
    console.error("retention: pruneRateLimitBuckets failed:", error.message);
    return { table: "rate_limit_buckets", error: error.message };
  }
  return { table: "rate_limit_buckets", deleted: count ?? 0, cutoffDays: days };
}

/**
 * vpn_link_usage_daily holds per-client daily byte counts and the last-seen
 * time of each Link client. The dashboard shows a 30-day window, so nothing
 * older is needed. Default: delete day buckets older than 35 days.
 */
export async function pruneLinkUsageDaily(supabase, env) {
  const days = envInt(env, "LINK_USAGE_RETENTION_DAYS", 35);
  const cutoff = daysAgoIso(days).slice(0, 10);
  const { error, count } = await supabase
    .from("vpn_link_usage_daily")
    .delete({ count: "exact" })
    .lt("bucket_date", cutoff);
  if (error) {
    console.error("retention: pruneLinkUsageDaily failed:", error.message);
    return { table: "vpn_link_usage_daily", error: error.message };
  }
  return { table: "vpn_link_usage_daily", deleted: count ?? 0, cutoffDays: days };
}

/**
 * Runs every retention step, each isolated so one table's failure doesn't
 * block the others. Called from functions/api/internal/retention-tick.js.
 */
export async function runRetention(supabase, env) {
  const steps = [
    pruneVpnLeases,
    pruneStripeEventPayloads,
    pruneProvisioningJobs,
    pruneNodeTrafficSamples,
    pruneTelegramLinkCodes,
    pruneNodeRevisions,
    clearStaleRevokedDeviceMetadata,
    pruneOperationalAlerts,
    pruneCompatibilityAuthorizations,
    pruneRateLimitBuckets,
    pruneLinkUsageDaily,
  ];
  const results = [];
  for (const step of steps) {
    try {
      results.push(await step(supabase, env));
    } catch (err) {
      console.error(`retention: ${step.name} threw:`, err.message);
      results.push({ table: step.name, error: err.message });
    }
  }
  return results;
}
