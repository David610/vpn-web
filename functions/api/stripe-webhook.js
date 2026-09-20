import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import {
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
} from "../lib/stripe-events.js";

export async function onRequestPost({ env, request }) {
  const sig = request.headers.get("Stripe-Signature");
  // Raw text, not request.json() — Stripe's HMAC covers the exact bytes
  // sent; re-serializing parsed JSON would produce a different byte string
  // and every signature would fail verification.
  const body = await request.text();

  const stripe = new Stripe(env.STRIPE_API_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  // constructEventAsync + createSubtleCryptoProvider, never the sync
  // constructEvent — Cloudflare Workers has no synchronous Node crypto.
  const webCrypto = Stripe.createSubtleCryptoProvider();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_SIGNING_SECRET,
      undefined,
      webCrypto
    );
  } catch (err) {
    // Log the real reason; the response body is fixed and generic — never
    // echo Stripe SDK internals (timestamp/signature detail) to an
    // unauthenticated caller.
    console.error("stripe-webhook: signature verification failed:", err.message);
    return new Response("Bad Request", { status: 400 });
  }

  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Idempotency: look up this event id first. A row with processed_at set
  // means this exact event already succeeded — return 200 without
  // reprocessing. A row that exists but has processed_at = null means a
  // prior attempt was recorded but never finished — fall through and retry
  // the handler rather than silently treating it as done.
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("stripe_events")
    .select("processed_at")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (lookupError) {
    console.error("stripe-webhook: event lookup failed:", lookupError.message);
    return new Response("Internal error", { status: 500 });
  }
  if (existing?.processed_at) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!existing) {
    const { error: insertError } = await supabaseAdmin
      .from("stripe_events")
      .insert({ stripe_event_id: event.id, event_type: event.type, payload: event });
    if (insertError) {
      if (insertError.code === "23505") {
        // A truly concurrent delivery of the same event id won this race —
        // that request is (or will shortly be) doing the real work. Return
        // 200 rather than 500, so Stripe doesn't schedule an unnecessary
        // retry for an event that's already being handled.
        return new Response(JSON.stringify({ received: true, duplicate: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.error("stripe-webhook: failed to record event:", insertError.message);
      return new Response("Internal error", { status: 500 });
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(supabaseAdmin, event.data.object);
        break;
      case "invoice.paid":
        await handleInvoicePaid(supabaseAdmin, event.data.object);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(supabaseAdmin, event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabaseAdmin, event.data.object);
        break;
      default:
        // Unhandled event types are not an error — Stripe sends many event
        // types this integration doesn't act on yet.
        break;
    }
  } catch (err) {
    console.error(`stripe-webhook: failed to handle ${event.type}:`, err.message);
    // Leave processed_at unset so Stripe's retry (it retries until 2xx)
    // re-attempts the handler instead of this failure being silently final.
    return new Response("Internal error", { status: 500 });
  }

  const { error: markProcessedError } = await supabaseAdmin
    .from("stripe_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("stripe_event_id", event.id);
  if (markProcessedError) {
    console.error("stripe-webhook: failed to mark event processed:", markProcessedError.message);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
