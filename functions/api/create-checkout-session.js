import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getAccountForUser } from "../lib/accounts.js";

export async function onRequestPost({ env, request }) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "Authorization required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    // A checkout.session.completed for a delayed-payment method (e.g. SEPA
    // Direct Debit — see stripe-events.js's header comment) inserts the
    // subscriptions row at status "incomplete" until invoice.paid confirms
    // payment. Without also blocking a retry here, a user in that window
    // (who GET /api/vpn/config correctly shows as not-yet-active) would hit
    // "Subscribe" again and get a second paid subscription — the exact
    // dedup hole this endpoint exists to close. So "incomplete" must count
    // too, but unlike a real active subscription an "incomplete" row can
    // get stuck forever (abandoned/failed Checkout Session — Stripe expires
    // those after 24h by default) with no event ever arriving to move it
    // out of that status. Scope the "incomplete" branch to rows created in
    // the last 24h so a stuck one doesn't permanently block the user from
    // ever subscribing again; real active/trialing/past_due subscriptions
    // are never time-limited.
    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(
        `create-checkout-session: user ${user.id} has no account_members row`
      );
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const recentCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existingSubscription, error: existingSubError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("account_id", account.accountId)
      .or(
        `status.in.(trialing,active,past_due),and(status.eq.incomplete,created_at.gt.${recentCutoffIso})`
      )
      .limit(1)
      .maybeSingle();
    if (existingSubError) {
      console.error("create-checkout-session: subscription lookup failed:", existingSubError.message);
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (existingSubscription) {
      return new Response(
        JSON.stringify({ error: "You already have an active subscription" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
        client_reference_id: user.id,
        customer_email: user.email,
        success_url: `${env.SITE_URL}/dashboard/?checkout=success`,
        cancel_url: `${env.SITE_URL}/dashboard/?checkout=cancel`,
      });
    } catch (err) {
      console.error("create-checkout-session: Stripe error:", err.message);
      return new Response(JSON.stringify({ error: "Could not start checkout" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Catch-all for anything unexpected — bad/missing env bindings throwing
    // synchronously from createClient/Stripe, a Supabase network error, etc.
    // Never let Cloudflare's raw error page leak past this handler; log the
    // real reason and return the same fixed generic error shape as
    // stripe-webhook.js.
    console.error("create-checkout-session: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Something went wrong" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
