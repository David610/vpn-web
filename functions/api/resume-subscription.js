// F-12/C-03: see cancel-subscription.js — same history, same fix. This
// legacy route let ANY member of a legacy multi-member account clear
// cancel_at_period_end on Stripe directly, with no owner check. Confirmed
// unused (no caller in this repo or in the sibling tamara-next app); it now
// answers 410 Gone rather than a 404 that would look transient.
export async function onRequestPost() {
  return new Response(
    JSON.stringify({
      error: "This endpoint has been retired. Use /api/account/subscriptions/:id/resume instead.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
}
