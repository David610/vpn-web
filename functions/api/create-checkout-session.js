import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { getAccountForUser } from "../lib/accounts.js";

const TRIAL_DAYS = 3;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Starts either the one-time 3-day trial or an immediately-paid subscription.
 *
 * Body: { trial?: boolean }. Omitted keeps the historical behaviour
 * (trial=true); the dashboard explicitly sends true/false for its two CTAs.
 */
export async function onRequestPost({ env, request }) {
  const authHeader = request.headers.get("Authorization");
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return json({ error: "Authorization required" }, 401);

  let wantsTrial = true;
  try {
    const raw = await request.text();
    if (raw) wantsTrial = JSON.parse(raw)?.trial !== false;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  let reservedAt = null;
  let accountId = null;

  try {
    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user },
      error: tokenError,
    } = await supabaseAdmin.auth.getUser(accessToken);
    if (tokenError || !user) return json({ error: "Invalid or expired token" }, 401);

    const account = await getAccountForUser(supabaseAdmin, user.id);
    if (!account) {
      console.error(`create-checkout-session: user ${user.id} has no account_members row`);
      return json({ error: "Something went wrong" }, 500);
    }
    if (account.role !== "owner") {
      return json({ error: "Only the account owner can start or change a subscription." }, 403);
    }
    accountId = account.accountId;

    // Prevent duplicate live subscriptions, including a recent incomplete
    // Checkout that may still be awaiting a delayed payment method.
    const recentCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existingSubscription, error: existingSubError } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("account_id", accountId)
      .or(
        `status.in.(trialing,active,past_due),and(status.eq.incomplete,created_at.gt.${recentCutoffIso})`
      )
      .limit(1)
      .maybeSingle();
    if (existingSubError) {
      console.error("create-checkout-session: subscription lookup failed:", existingSubError.message);
      return json({ error: "Something went wrong" }, 500);
    }
    if (existingSubscription) {
      return json({ error: "You already have an active subscription" }, 409);
    }

    const { data: accountRow, error: accountError } = await supabaseAdmin
      .from("customer_accounts")
      .select("stripe_customer_id")
      .eq("id", accountId)
      .maybeSingle();
    if (accountError) throw new Error(`customer_accounts lookup failed: ${accountError.message}`);

    if (wantsTrial) {
      const { data: reservation, error: reservationError } = await supabaseAdmin.rpc(
        "reserve_free_trial",
        { p_account_id: accountId }
      );
      if (reservationError) {
        throw new Error(`trial reservation failed: ${reservationError.message}`);
      }
      if (!reservation) {
        return json(
          {
            error: "The free trial has already been used or is already being started.",
            code: "trial_unavailable",
          },
          409
        );
      }
      reservedAt = reservation;
    }

    const stripe = new Stripe(env.STRIPE_API_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const checkoutParams = {
      mode: "subscription",
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      success_url: `${env.SITE_URL}/dashboard/?checkout=success`,
      cancel_url: `${env.SITE_URL}/dashboard/?checkout=cancel`,
      ...(wantsTrial ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {}),
      ...(accountRow?.stripe_customer_id
        ? { customer: accountRow.stripe_customer_id }
        : { customer_email: user.email }),
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(checkoutParams);
    } catch (err) {
      // Release only our own reservation. A later request may already have
      // created a new reservation after the 24h timeout, so never clear by
      // account id alone.
      if (wantsTrial && reservedAt) {
        const { error: releaseError } = await supabaseAdmin
          .from("customer_accounts")
          .update({ trial_reserved_at: null })
          .eq("id", accountId)
          .eq("trial_reserved_at", reservedAt)
          .is("trial_used_at", null);
        if (releaseError) {
          console.error("create-checkout-session: trial reservation release failed:", releaseError.message);
        }
      }
      console.error("create-checkout-session: Stripe error:", err.message);
      return json({ error: "Could not start checkout" }, 502);
    }

    return json({ url: session.url, trial: wantsTrial });
  } catch (err) {
    console.error("create-checkout-session: unexpected error:", err.message);
    return json({ error: "Something went wrong" }, 500);
  }
}
