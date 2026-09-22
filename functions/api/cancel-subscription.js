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

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      return new Response(JSON.stringify({ error: "No active subscription" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: subscription, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("account_id", account.accountId)
      .in("status", ["trialing", "active", "past_due"])
      .maybeSingle();
    if (subError) {
      console.error("cancel-subscription: subscription lookup failed:", subError.message);
      return new Response(JSON.stringify({ error: "Something went wrong" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!subscription) {
      return new Response(JSON.stringify({ error: "No active subscription" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    try {
      // Only sets the flag — actual status/cancel_at_period_end row update
      // happens via the customer.subscription.updated webhook, same
      // single-source-of-truth pattern as every other subscription write
      // (functions/lib/stripe-events.js).
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch (err) {
      console.error("cancel-subscription: Stripe error:", err.message);
      return new Response(JSON.stringify({ error: "Could not cancel subscription" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("cancel-subscription: unexpected error:", err.message);
    return new Response(JSON.stringify({ error: "Something went wrong" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
