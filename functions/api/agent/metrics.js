/**
 * Retired: no caller in the singbox-vpn provisioning agent ever posts to
 * this route (confirmed by searching singbox-vpn for any reference to
 * `agent/metrics` or `record_vpn_usage`), so the per-user usage samples it
 * accepted were never produced and `GET /api/vpn/usage`
 * (`functions/api/vpn/usage.js`) — its only reader — always reported
 * `unavailable`. Retired together (F-21).
 *
 * This was a mutation endpoint (it wrote to `vpn_usage_current` /
 * `vpn_usage_hourly` via `record_vpn_usage_sample`), so it returns an
 * explicit 410 rather than being silently deleted: a node build that still
 * has old code calling this gets a clear, typed answer instead of a 404
 * that looks like a routing bug or a 500 that looks like a server fault.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost() {
  return json(
    {
      error: "Per-user usage metrics ingestion is retired.",
      code: "metrics_retired",
    },
    410
  );
}
