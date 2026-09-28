import { jsonResponse } from "../../lib/user-auth.js";

/**
 * Retired: no code path ever writes per-user usage samples that this
 * endpoint could read. `POST /api/agent/metrics` (the only writer of
 * `vpn_usage_current`/`record_vpn_usage_sample`) has no caller in the
 * singbox-vpn provisioning agent, so this table is always empty and this
 * endpoint always returned `{ available: false }`. `UsageCard.tsx`, the
 * only client of this route, was never imported anywhere and has been
 * removed alongside it (F-21).
 *
 * Kept as an explicit 410 rather than deleted outright so any stray caller
 * gets a clear, typed answer instead of a 404 that looks like a routing
 * bug.
 */
export async function onRequestGet() {
  return jsonResponse(
    {
      error: "Usage telemetry is not available. This endpoint is retired.",
      code: "usage_retired",
    },
    410
  );
}
