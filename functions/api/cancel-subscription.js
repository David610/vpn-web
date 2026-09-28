// F-12/C-03: this legacy route predates the role check that
// functions/lib/account-service.js's cancelSubscription (exposed today via
// /api/account/subscriptions/[id]/cancel and /v1/subscriptions/[id]/cancel)
// now enforces — it let ANY member of a legacy multi-member account toggle
// cancel_at_period_end on Stripe directly, with no owner check at all.
// Confirmed unused: no caller exists in this repo's src/ or functions/, and
// none in the sibling tamara-next app. Rather than delete it outright (a
// stale client pointed at this path should get a clear, permanent signal,
// not a 404 that looks transient), it now answers 410 Gone.
export async function onRequestPost() {
  return new Response(
    JSON.stringify({
      error: "This endpoint has been retired. Use /api/account/subscriptions/:id/cancel instead.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
}
